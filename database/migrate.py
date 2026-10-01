import asyncio, os, sys
from pathlib import Path
import aiomysql
from dotenv import load_dotenv

# ../app/.env resolves both in the container (/database -> /app) and from a local checkout.
load_dotenv(Path(__file__).parent.parent / "app" / ".env")

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
LOCK_NAME = "chatapp_migrations"

LEDGER = """
CREATE TABLE IF NOT EXISTS schema_migrations(
  version    VARCHAR(255) NOT NULL,
  applied_at DATETIME(6)  NOT NULL,
  PRIMARY KEY(version)
)
"""

def split_statements(sql: str) -> list[str]:
    """Split on statement-terminating semicolons only.

    A plain sql.split(";") breaks on semicolons inside comments and string
    literals, so this walks the text tracking which construct it is inside and
    only treats ';' as a terminator at the top level. Does not handle DELIMITER,
    so no stored procedures or triggers.
    """
    statements, buf = [], []
    i, n = 0, len(sql)
    quote = None        # the closing char of the string literal we are inside
    comment = None      # 'line' or 'block'

    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""

        if comment == "line":
            if ch == "\n":
                comment = None
                buf.append(ch)
            i += 1
            continue
        if comment == "block":
            if ch == "*" and nxt == "/":
                comment = None
                i += 2
                continue
            i += 1
            continue
        if quote:
            buf.append(ch)
            if ch == "\\" and quote != "`":       # backslash escapes, except in identifiers
                if nxt:
                    buf.append(nxt)
                    i += 2
                    continue
            elif ch == quote:
                if nxt == quote:                  # '' / "" is an escaped quote, not the end
                    buf.append(nxt)
                    i += 2
                    continue
                quote = None
            i += 1
            continue

        # -- needs trailing whitespace to be a comment in MySQL; # always is
        if (ch == "-" and nxt == "-" and (i + 2 >= n or sql[i + 2] in " \t\r\n")) or ch == "#":
            comment = "line"
            i += 1
            continue
        if ch == "/" and nxt == "*":
            comment = "block"
            i += 2
            continue
        if ch in "'\"`":
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                statements.append(stmt)
            buf = []
            i += 1
            continue

        buf.append(ch)
        i += 1

    tail = "".join(buf).strip()
    if tail:
        statements.append(tail)
    return statements

async def connect_with_retry(host, port, user, password, database, attempts=30, delay=2.0):
    """A fresh MySQL volume takes ~30s to initialize; compose's healthcheck covers the
    common case, but retrying here means the runner survives a slow or restarting DB."""
    for attempt in range(1, attempts + 1):
        try:
            return await aiomysql.connect(
                host=host, port=port, user=user, password=password, db=database,
                autocommit=True,      # DDL self-commits in MySQL; no transaction to wrap
            )
        except Exception as e:
            if attempt == attempts:
                print(f"could not reach {host}:{port} after {attempts} tries: {e}", file=sys.stderr)
                raise
            print(f"waiting for {host}:{port} ({attempt}/{attempts}) ...", flush=True)
            await asyncio.sleep(delay)


async def main() -> int:
    user = os.getenv("DB_USER")
    password = os.getenv("DB_PASSWORD")
    database = os.getenv("DB_DATABASE")
    APP_ENV = os.getenv("APP_ENV")
    if APP_ENV != "DOCKER":
        host = "127.0.0.1"
        port = 3307
    else:
        host = "mysql_db"
        port = 3306
    conn = await connect_with_retry(host, port, user, password, database)
    try:
        async with conn.cursor() as cur:
            # Serialize concurrent runners (multiple backend replicas booting at once).
            await cur.execute("SELECT GET_LOCK(%s, 30)", (LOCK_NAME,))
            if (await cur.fetchone())[0] != 1:
                print("could not acquire migration lock", file=sys.stderr)
                return 1

            await cur.execute(LEDGER)
            await cur.execute("SELECT version FROM schema_migrations")
            applied = {row[0] for row in await cur.fetchall()}

            pending = sorted(
                p for p in MIGRATIONS_DIR.glob("*.sql") if p.stem not in applied
            )
            if not pending:
                print("schema up to date")
                return 0

            for path in pending:
                print(f"applying {path.stem} ...", flush=True)
                for stmt in split_statements(path.read_text()):
                    await cur.execute(stmt)
                await cur.execute(
                    "INSERT INTO schema_migrations(version, applied_at) VALUES(%s, UTC_TIMESTAMP(6))",
                    (path.stem,),
                )
                print(f"  {path.stem} ok", flush=True)

            await cur.execute("SELECT RELEASE_LOCK(%s)", (LOCK_NAME,))
        return 0
    finally:
        conn.close()

if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
