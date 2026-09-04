# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Real-time chat app: FastAPI + WebSockets backend, MySQL for persistence, Redis pub/sub for
cross-connection message fan-out, nginx serving a vanilla-JS frontend and reverse-proxying the API.
Everything runs through Docker Compose.

## Commands

```sh
docker compose up            # full stack: nginx :8080, backend :8000, mysql :3307, redis :6379
./docker_rebuild.sh          # prunes containers/images/volumes then `up` — REQUIRED after schema.sql,
                             # init-db.sql or testdata.sql changes (see "Database init" below)
```

Backend outside Docker (DB/Redis still from Compose):

```sh
source venv/bin/activate
cd app && uvicorn main:app --reload      # must run from app/ — imports are flat, and load_dotenv()
                                         # picks up app/.env from the cwd
```

- No test suite and no linter are configured. Type checking is via `pyrightconfig.json`
  (`include: app`, `extraPaths: ./app` so the flat imports resolve) — run `pyright` if available.
- Manual API checks: FastAPI docs at `http://localhost:8000/docs`.
- Manual WebSocket checks: open `static/client1.html` and `static/client2.html` — bare test
  harnesses hard-coding `client_id` 2/3 and the chat UUIDs from `database/testdata.sql`. They
  connect straight to `ws://127.0.0.1:8000/ws`, bypassing nginx.
- Dependencies are `pip install`ed by the container entrypoint on every start, so after editing
  `app/requirements.txt` just restart the `backend` container — no image rebuild needed.

## Required local setup (both files are gitignored)

- `app/.env` — from `app/.env.example` (`DB_USER`, `DB_PASSWORD`, `DB_DATABASE`, `JWT_SECRET_KEY`).
  This same file is passed as `env_file` to the `mysql_db` and `redis` services, so MySQL image
  variables belong here too.
- `database/init-db.sql` — from `database/init-db.sql.example`; creates the DB user matching
  `.env` and the seed admin row.

## Architecture

### Environment switching

`app/db.py` reads `APP_ENV` and picks hosts for the whole app: `DOCKER` → `mysql_db:3306` /
`redis:6379`; anything else → `127.0.0.1:3307` / `127.0.0.1:6379`. `app/pubsub.py` imports
`APP_ENV` from `db.py` rather than reading the env itself. Compose sets `APP_ENV=DOCKER` on the
backend service only.

### Request/socket flow

nginx (`nginx/nginx.conf`) serves `static/` at `:8080` and proxies `/api/` → `http://backend:8000/`
(the trailing slash strips the `/api` prefix, so backend routes are declared without it — e.g.
frontend calls `/api/login`, the router declares `/login`). **`/ws` is not proxied**; WebSocket
clients must hit the backend port directly.

### Auth

`app/routers/users.py` issues a HS256 JWT (`{user, role, user_id}`) in an httpOnly `session` cookie,
good for `ACCESS_TOKEN_EXPIRE_MINUTES` (600, i.e. 10h), plus an opaque refresh token in a second
httpOnly cookie scoped to `path=/api/refresh` and good for 7 days. Only the sha256 of the refresh
token is stored (`refresh_tokens`); the raw value never reaches the DB. `POST /refresh` rotates the
pair and revokes the old hash. `verify_jwt` is a `Cookie()`-based dependency and returns `None` (not
a 401) on failure — callers must check. The WebSocket endpoint takes it as a `Depends` and derives
`client_id` from the session.

`GET /users?q=<prefix>&limit=` (`search_username`) prefix-matches `display_name`/`username`,
excludes the caller, and clamps `limit` to 25. `%`, `_` and `\` in `q` are escaped before the `LIKE`.

### Messaging pipeline (`app/routers/websocket.py`)

1. On connect: session → `client_id`, `get_chats()` lists the user's `chat_id`s, `WebsocketManager`
   registers the socket under each chat in `manager.chats`. It does **not** touch pubsub — the
   reader `psubscribe("*")`s once in the router's `startup` hook and owns that connection alone;
   subscribing from a request task races the reader's read ("readuntil() already waiting").
2. Undelivered rows (`message_status.status = 'NOT-DELIVERED'`) are replayed as a bare
   `{chat_id: [MessageFrame, ...]}` map (no top-level `type`), grouped by chat and sorted by
   `time_sent` (`app/dependencies.py`), then marked `DELIVERED`.
3. Inbound frame `{client_id, chat_id, message}` → `insert_message()` writes the row plus one
   `message_status` row per other chat member → sender gets an `ack` → the text is `PUBLISH`ed to
   the Redis channel named after `chat_id`.
4. A single background task (`pubsub_reader`, started in the router's `startup` hook) consumes all
   channels and dispatches each frame through `_handle_pubsub_message()`, which pushes to every
   socket in `manager.chats[chat_id]`. Each frame is handled inside its own `try` — one malformed
   payload is logged and skipped instead of killing fan-out for the whole worker.

Redis is what makes this work across multiple backend workers/instances — a message is never sent
straight to peer sockets, it always round-trips through pub/sub.

**The `control` channel.** `chat_id` channels carry messages; the reserved `control` channel carries
membership changes, handled by `_handle_control()`. `POST /create_chat` publishes
`{type:"create_channel", chat_id, user_ids}` after the DB insert; each worker then registers the new
chat for whichever of those users it holds a live socket for and pushes them a
`{type:"chat_created", chat_id}` frame so the client refetches `/chats`. Without this a new chat
stayed invisible until the socket reconnected. Appends are deduped against the existing entry,
because `connect()` may already have registered that same socket.

Note: the send path trusts the client-supplied `client_id` in the frame instead of the session's;
this is a known gap, tracked as item #5 in the `chat.js` integration comments.

Note: `POST /chat/delete_chat` (`app/routers/chats.py`) is an unfinished stub — its membership check
compares a `str` against the one-tuples `get_chats()` returns, so it always raises a bare
`PermissionError` and 500s, and `connection.delete_chat()` holds no query. Nothing calls it yet.

### Database (`app/db.py`)

One `Database` singleton (`connection`) wrapping an `aiomysql` pool created in `main.py`'s startup
hook. The pool is `autocommit=False` and every method goes through the `_transaction()` async
context manager, which yields a cursor, commits on clean exit and rolls back on any exception — so a
multi-statement write is atomic. Use `%s` placeholders. All SQL lives here; routers never talk to
the driver directly.

Schema (`database/schema.sql`): `users`, `chats`, `chat_users` (join), `messages`,
`message_status` (per-recipient delivery state, the basis of offline delivery).

**Database init:** SQL under `/docker-entrypoint-initdb.d/` only runs when the `chatapp-db` volume
is empty, so any change to `schema.sql` / `init-db.sql` / `testdata.sql` needs the volume dropped —
that is what `docker_rebuild.sh` is for. `database/Dockerfile` (dev) also loads `testdata.sql`;
`Dockerfile.prod` does not.

### Frontend (`static/`)

Plain HTML/CSS/JS, no build step or framework; nginx bind-mounts the directory so edits are live.
Built to `FRONTEND_SPEC.md` — read that for the API/WS shapes and the data-mapping rules.

- `index.html` + `css/app.css` — two-pane "iMessage clean" shell (sidebar + chat + composer),
  tokens on `:root`, dark theme via `prefers-color-scheme`, `body[data-view]` toggles the
  single-pane mobile layout.
- `js/api.js` — `API.apiFetch()` adds the `/api` prefix and `credentials: "include"`; a 403
  triggers one single-flight `POST /api/refresh` and a retry, else redirects to `/login/`.
- `js/ws.js` — `WS.connect()` to `ws://<host>:8000/ws` (direct, not via nginx), backoff
  reconnect (runs `API.getMe()` first so an expired session is refreshed before the handshake),
  routes the five inbound frame shapes
  (`message`/`ack`/`error`/`chat_created`/type-less pending map).
- `js/app.js` — `state`, rendering, events, boot. Own messages render only on the echoed
  `message` frame (never optimistically). Unread counts are client-side after boot; "older"
  pages use `offset = loaded count`. A `chat_created` frame triggers `refreshChats()` when the chat
  is unknown, which is why creating a chat no longer forces a `WS.reconnect()`. Scripts load in
  order: api → ws → app.
- `login/` — sign-in / create-account card; branches on HTTP status, not message strings.
- "New chat" is still a dev affordance taking raw user ids. `GET /api/users?q=` (see Auth) now
  exists on the backend but is not wired into the dialog yet, and `index.html` still carries the
  "no user directory" copy and TODO.
- `client1.html` / `client2.html` remain as bare WS harnesses.

## Entrypoint scripts

`app/Dockerfile` copies **`entrypoint.sh`** to `/dev_entrypoint.sh` — the file named
`dev_entrypoint.sh` in the repo is not the one that runs. The active script runs
`uvicorn main:app --reload` with workdir `/app`, which is why backend modules import flatly
(`from db import connection`, `from routers.users import verify_jwt`) rather than as an `app.`
package. `prod_entrypoint.sh` (`fastapi run`) is unused by the current Compose file.
