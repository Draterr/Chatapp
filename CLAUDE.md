# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Real-time chat app: FastAPI + WebSockets backend, MySQL for persistence, Redis pub/sub for
cross-connection message fan-out, nginx serving a vanilla-JS frontend and reverse-proxying the API.
Everything runs through Docker Compose.

## Commands

```sh
docker compose up            # full stack: nginx :8080, backend :8000, mysql :3307, redis :6379
./docker_rebuild.sh          # prunes containers/images/volumes then `up` — wipes all data; only
                             # needed after init-db.sql changes (see "Database init" below)
python database/migrate.py   # apply new migrations against the running DB from the host
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
  connect straight to `ws://127.0.0.1:8000/ws`, bypassing nginx. `testdata.sql` is no longer loaded
  by `database/Dockerfile`, so those chats don't exist on a fresh volume unless you load it by hand.
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
frontend calls `/api/login`, the router declares `/login`). `/ws` **is** proxied too (with the
`Upgrade`/`Connection` headers and a 3600s read timeout), but `js/ws.js` and the test harnesses still
connect straight to the backend on `:8000`, so the proxy route is currently unused.

### Auth

`app/routers/users.py` issues a HS256 JWT (`{user, role, user_id}`) in an httpOnly `session` cookie,
good for `ACCESS_TOKEN_EXPIRE_MINUTES` (600, i.e. 10h), plus an opaque refresh token in a second
httpOnly cookie scoped to `path=/api/refresh` and good for 7 days. Only the sha256 of the refresh
token is stored (`refresh_tokens`); the raw value never reaches the DB. `POST /refresh` rotates the
pair and revokes the old hash. `verify_jwt` is a `Cookie()`-based dependency and returns `None` on
failure — callers must check, and every one of them raises **401** `Unauthorized`. The WebSocket
endpoint takes it as a `Depends` and derives `client_id` from the session.

**401 vs 403 is load-bearing.** `401` means "we don't know who you are": no/invalid/expired session
cookie, a wrong password at `POST /login`, and a missing, unknown, revoked or expired refresh token at
`POST /refresh`. `403` means "we know who you are and the answer is no": not a member, not an admin,
sole admin, can't leave/delete a DM. The frontend's refresh interceptor keys on `401` only, so a new
endpoint that answers an auth failure with `403` won't trigger a refresh, and one that answers a
permission failure with `401` will needlessly rotate the user's token pair and retry. The refresh
endpoint's `refresh_token` cookie parameter needs its `= None` default; without it FastAPI rejects a
missing cookie with `422` before the handler's own `401` can run.

`GET /users?q=<prefix>&limit=` (`search_username`) prefix-matches `display_name`/`username`,
excludes the caller, and clamps `limit` to 25. `%`, `_` and `\` in `q` are escaped before the `LIKE`.

`POST /passwordchange` takes a **JSON body** of all three fields — `{old_password, new_password,
confirm_new_password}` — and re-hashes with `bcrypt` at 12 rounds (`db.change_password()`).
`200 {"message":"Successfully Changed Password"}`; `403 Password Missmatch` (the server's spelling)
when new and confirm differ; `403 Password does not meet the requirement` when `new_password` fails
`rgx` — 8+ characters with a lowercase, an uppercase, a digit, a symbol and no whitespace.

**On success it revokes every refresh token for that user and then issues the caller a fresh pair**
(`revoke_refresh_token` → `insert_refresh_token` → `set_auth_cookies`, in that order, so the new row
isn't caught by its own revoke). So a password change signs out every *other* device while leaving
the one that performed it signed in — verified end to end: the pre-change cookie jar gets
`401 Invalid or expired refresh token` from `POST /refresh` while the caller's new pair refreshes
fine and `/me` keeps working.

Two things about it are load-bearing for anything built on top:

- **`old_password` is required but never checked.** It is a non-optional field on the pydantic model,
  so omitting it is a `422`, but the handler never reads its value — a valid `session` cookie is the
  only thing actually required to change the password. Until the handler verifies it, the field is
  a prompt, not a control, and no UI may claim the current password was confirmed.
- The two validation refusals must stay **`403`, not `401`** (they were briefly `401`). The
  frontend's interceptor keys on `401`, so a `401` here makes a mistyped confirmation refresh and
  silently re-submit the change — and since a successful change revokes the old tokens, the *second*
  mistyped attempt would then refresh against a revoked cookie, fail, and bounce the user to
  `/login`. A wrong-`old_password` check, when added, must answer `403` for the same reason.
  Separately, `rgx` is matched with `$`, which in Python also matches before a trailing newline, so
  `"Passw0rd!\n"` passes and is hashed with the newline; `\Z` or `re.fullmatch` closes that.

### Chats, membership and roles (`app/routers/chats.py`)

`GET /chats` returns `{data: [...]}`, and each chat carries `is_dm` (a real boolean, on every chat)
plus a `role` of `"admin"` or `"user"` on **every** member:

```json
{ "chat_id": "…", "chat_name": "grp", "is_dm": false,
  "members": [ {"user_id": 6, "display_name": "…", "avatar_url": null, "role": "admin"},
               {"user_id": 7, "display_name": "…", "avatar_url": null, "role": "user"} ],
  "unread_message_count": 0, "last_message": { … } }
```

A group's creator is its `admin` and everyone else a `user`. **Both members of a DM are
`role: "user"`, so a DM never has an admin** — which is why admin-only actions are group-only.
This is also the only source of roles *and of the roster itself*: there is no members endpoint, so
the client re-reads `GET /chats` after every role change, add, leave or kick.

`POST /chat/delete_chat` takes a **JSON body** `{"chat_id": "<uuid>"}` and deletes the group and its
messages for everyone (the FK cascade covers chats with history). `200 {"message":"Chat deleted
successfully"}`; `403` with `detail` one of `You are not a member of this chat!`, `You can't delete a
DM chat!` (DMs can never be deleted server-side) or `You are not an admin of this chat!`. On success
it publishes `delete_channel` on the `control` channel — see below.

`POST /chat/change_role?chat_id=<uuid>&user_id=<int>&new_role=admin|user` promotes or demotes a
member. It takes **query parameters, not a body** — inconsistent with the other POSTs here and
deliberate for now, so don't "fix" it into a body. `200 {"message":"Role changed successfully"}`;
`403 There must be at least one admin in the chat!` when the demotion would leave the group with no
admin (including an admin demoting themselves), plus the same not-an-admin / not-a-member `403`s;
`422` with a pydantic `literal_error` if `new_role` is anything but `admin` or `user`. It publishes
nothing, so other clients only see the new roles on their next `GET /chats`.

`POST /chat/{chat_id}/add_member` takes `chat_id` in the **path** and a **bare JSON array of user
ids** as the whole body — `[16]` or `[16,17]`, *not* `{"user_id": [...]}`, because the handler
declares `user_id: list[int]` as the body itself. Admin-only and group-only. Added members always
get `role: "user"`. `200 {"message":"Member added successfully"}`; `400 User <id> is already a member
of this chat!` with the **raw id interpolated** into the message — and it fires before any insert,
since every id is checked first, so a rejected batch adds nobody; `403` with `detail` one of `You
can't add members to a DM!`, `You are not an admin of this chat!`, `You are not a member of this
chat!`. It publishes one `add_member` control frame per added id.

`POST /chat/{chat_id}/leave` takes `chat_id` in the **path** and **no body and no query params**.
Any member of a group can leave. `200 {"message":"Left the chat successfully"}`; `403 You can't leave
a DM chat!`; `403 There must be at least one admin in the chat!` when the **sole admin** tries to
leave — they have to promote someone else first, which is the one error here worth real UI copy;
`403 You are not a member of this chat!`, which is also what a second, duplicate leave returns. On
success it publishes a `remove_member` control frame.

`POST /chat/{chat_id}/kick?user_id=<int>` removes somebody else. `chat_id` is in the **path** and
`user_id` is a **query parameter**, with **no body** — the same split `change_role` uses, and
deliberate, so don't "fix" it. **Only an admin can kick, and only a plain member:** an admin has to
be demoted before they can be removed, and a sole admin removing a plain member is fine. Self-kick
isn't special-cased — leaving is the endpoint for that. `200 {"message":"User kicked from the chat
successfully"}`; `403` with `detail` one of `You are not a member of this chat!`, `You can't kick
someone from a DM chat!`, `You can't kick an admin from the chat!` (both for an admin target and for
a plain member aiming at one) or `You can't kick a user from the chat!` (a plain member aiming at
anybody); `404 User not found in this chat` when the target isn't a member. On success it writes a
`member_kicked` system row (fanned out on the chat's own channel, so everyone *still* in the chat
sees it) **and** publishes a `remove_member` control frame — which, as ever, reaches only the one
user it is about, i.e. the person kicked. The admin who issued it gets neither frame and must
re-read `GET /chats` itself.

So `remove_member` no longer only ever describes the caller leaving: it is also how the kicked
member finds out. Nothing in that frame says which it was, and nothing needs to — either way that
user is out of that chat.

`POST /chat/{chat_id}/rename?new_name=<str>` renames a group: `chat_id` in the **path**,
`new_name` as a **query parameter**, no body. Admin-only and group-only. `200 {"message":"Chat
renamed successfully"}`; `403` for not-a-member / not-an-admin / `You can't rename a DM chat!`;
`404 Chat not found` only when the chat genuinely doesn't exist — renaming to the name it already
has is a no-op `200`, because `UPDATE`'s `rowcount` is `0` both for "no such row" and "no change",
so `rename_chat()` checks existence with its own `SELECT` instead of inferring it. On success it
announces a `chat_renamed` system event (carrying `{"new_name": …}` in `data`) **and** publishes
`rename_channel` on `control`, which each worker turns into a `chat_renamed` client frame.

Both of `announce()`'s payload arguments (`target_id`, `data`) are keyword-only **with defaults**,
so a caller that omits one can't raise a `TypeError` at the call site — outside `announce`'s own
try/except, where it would turn an already-committed change into a 500. That is exactly how the
rename announcement used to fail.

### Messaging pipeline (`app/routers/websocket.py`)

1. On connect: session → `client_id`, `get_chats()` lists the user's `chat_id`s, `WebsocketManager`
   registers the socket under each chat in `manager.chats`. It does **not** touch pubsub — the
   reader `psubscribe("*")`s once in the router's `startup` hook and owns that connection alone;
   subscribing from a request task races the reader's read ("readuntil() already waiting").
2. Undelivered rows (`message_status.status = 'NOT-DELIVERED'`) are replayed as a bare
   `{chat_id: [MessageFrame, ...]}` map (no top-level `type`), grouped by chat and sorted by
   `time_sent` (`app/dependencies.py`), then marked `DELIVERED`.
3. Inbound frame `{type: "message", chat_id, message}` → `insert_message()` writes the row plus one
   `message_status` row per other chat member → sender gets an `ack` → the text is `PUBLISH`ed to
   the Redis channel named after `chat_id`.
4. A single background task (`pubsub_reader`, started in the router's `startup` hook) consumes all
   channels and dispatches each frame through `_handle_pubsub_message()`, which pushes to every
   socket in `manager.chats[chat_id]`. Each frame is handled inside its own `try` — one malformed
   payload is logged and skipped instead of killing fan-out for the whole worker.

Redis is what makes this work across multiple backend workers/instances — a message is never sent
straight to peer sockets, it always round-trips through pub/sub.

**The `control` channel.** `chat_id` channels carry messages; the reserved `control` channel carries
membership changes, handled by `_handle_control()`. `POST /create_chat` — which returns
`{chat_id}`, 400 when `is_dm` is set but membership isn't exactly 2, and 409 `chat already exists`
on a duplicate DM — publishes `{type:"create_channel", chat_id, user_ids}` after the DB insert;
each worker then registers the new chat for whichever of those users it holds a live socket for and
pushes them a `{type:"chat_created", chat_id}` frame so the client refetches `/chats`. Without this
a new chat stayed invisible until the socket reconnected. Appends are deduped against the existing
entry, because `connect()` may already have registered that same socket.

`POST /chat/delete_chat` publishes the mirror image, `{type:"delete_channel", chat_id}`. Each worker
pops that chat from `manager.chats` and pushes `{type:"chat_deleted", chat_id}` to every socket that
was registered under it — the deleter's own socket included, so the client that issued the DELETE
must treat its cleanup as idempotent. `ws.js` routes the frame; `app.js`'s `dropChat()` does the
cleanup and tolerates running twice.

`POST /chat/{chat_id}/rename` publishes `{type:"rename_channel", chat_id, new_name}`, which each
worker turns into `{type:"chat_renamed", chat_id, new_name}` for **every** socket registered under
that chat — the only membership-adjacent control frame that isn't addressed to one user. `ws.js`
routes it and `app.js` patches `chat.chat_name` in place, re-rendering the sidebar row, the header
and the conversation-info panel; a frame for an unknown chat falls back to `refreshChats()`. The
client has two rename entry points (the kebab's "Rename group" and `#membersRename` in the info
panel's head), both of which rely on this frame rather than applying the name locally — so if this
frame ever stops arriving, a rename looks like it did nothing until the next `GET /chats`.

**Typing (the one thing a client socket may publish).** Everything else a client wants to change
goes through REST; the socket's inbound allow-set is `CLIENT_CONTROL_ACTIONS = {"typing"}` in
`app/routers/websocket.py`. The frame is

```json
{"type": "control", "action": "typing", "chat_id": "<uuid>"}
```

— note `type` is `"control"` and `action` is what names it, so `WS.sendMessage()` can't send it;
`ws.js` has a separate `WS.sendTyping(chatId)`. **Never put a `user_id` in it**: the server always
uses the session's `client_id` and ignores the frame's. Any other `action` comes back as
`{"type":"error","code":"404","detail":"anything but typing frame must be done with api"}`, and a
`chat_id` the socket isn't registered under comes back as `{"type":"error","code":"400",
"detail":"Something Went Wrong"}` (both discard the frame). The frame is republished on the
`control` channel and each worker sends

```json
{"type": "user_typing", "chat_id": "<uuid>", "user_id": <int>}
```

to every socket registered under that chat **except the typist's** — you never see your own.

Two consequences the client has to live with:

- **There is no `typing_stop` frame, in either direction.** Nothing will ever say someone finished,
  so the receiver expires the indicator itself: `app.js` arms a `TYPING_TTL_MS` (5s) timer per
  typist per chat, reset by their next frame. Switching chats and losing the socket both clear every
  indicator; an inbound `message` clears its own sender's.
- **Each frame is a Redis round-trip out to every member**, so the sender throttles rather than
  firing per keystroke: `maybeSendTyping()` is leading-edge, one frame per chat per `TYPING_SEND_MS`
  (3s, comfortably inside the 5s TTL), never on an empty composer, never for a chat that isn't the
  open one, never while the socket is down. Sending a message resets the throttle so the next burst
  announces at once.

A `user_typing` frame can arrive for a chat that isn't open (the socket is registered for all of
them), so the state is per-chat: the open chat draws the line above the composer, every other chat
shows "typing…" in place of its sidebar preview. A frame for a chat the client doesn't know is
dropped rather than remembered.

**Membership frames, and what they don't tell you.** `add_member` and `remove_member` on the
`control` channel become two client frames:

```json
{"type":"member_added",   "chat_id":"<uuid>", "user_id":<int>}
{"type":"member_removed", "chat_id":"<uuid>", "user_id":<int>}
```

**Both are sent only to the one user they are about** — `_handle_control()` looks up
`active_connections[user_id]` and writes to that socket alone. Nobody else in the chat is told, so
when an admin adds C to a group, A and B are never notified and their `members` arrays (member
count, roster, roles) stay stale until their next `GET /chats`, which is the only source of
membership. This is a deliberate backend limitation, not a frontend bug; the frontend works around
it by refreshing after its own `200` and takes the late-arriving view for everyone else (a reconnect
refreshes, so staleness is bounded in practice). `member_added` also registers the new member's
socket under the chat, so they start receiving messages without reconnecting, and `member_removed`
deregisters the leaver's.

**System messages (membership/role events).** Every membership or role change also writes a row to
`messages` with `kind = 'system'` (`insert_system_message()`), which is then fanned out on the
chat's **own** channel — not `control` — as a `system` frame, and comes back from
`GET /chat/{id}/messages` interleaved with normal messages in `time_sent` order. There is one
server-side builder, `system_frame()` in `app/db.py`, so **the live copy and the historical copy are
byte-for-byte the same shape**:

```json
{ "type": "system",
  "message_id": "66a41c29-…",
  "chat_id": "10fb9911-…",
  "event": "member_added",
  "actor_id": 22, "actor_name": "Ada",
  "target_id": 24, "target_name": "Cleo",
  "message": "Ada added Cleo",
  "time_sent": "2026-10-01T16:49:18.123456+00:00" }
```

- `event` is exactly one of `member_added`, `member_left`, `member_kicked`, `promoted`, `demoted`,
  `chat_renamed` (`db.py`'s `SYSTEM_EVENTS`).
- **`data`** (from `messages.event_data`, a nullable `JSON` column added by
  `005_system_event_data.sql`) carries an event's own payload for the events that don't act on a
  person. Today only `chat_renamed` uses it, as `{"new_name": "…"}`; it is `{}` for the others.
  `target_id` is `NULL` for such an event, so `insert_system_message()` builds its display-name
  lookup from whichever of actor/target is actually present — a literal `IN (%s,%s)` with a `None`
  matches nothing and would lose the actor's name too. A new non-person event belongs here rather
  than in another nullable column.
- Leaving is self-initiated, so `member_left` has **`actor_id == target_id`** (and the same name in
  both fields); the other four have an actor acting on someone else.
- `member_kicked` is an admin removing a plain member. The kicked user gets this frame *and* a
  `member_removed` control frame, so they see both; everyone still in the chat gets only the system
  frame, and that is their only live notice that the roster moved.
- `message` is a server-rendered fallback sentence (`"Ada added Cleo"`, `"Cleo left"`, `"Ada kicked
  Cleo"`, `"Ada made Cleo an admin"`, `"Ada removed Cleo as an admin"`). A client that knows the
  `event` should build its own copy from `actor_name`/`target_name` (so it can say "You"); the
  fallback is for an `event` it doesn't recognise, so a future event still renders as *something*.
  The frontend deliberately says "removed" rather than the server's "kicked" for `member_kicked` —
  the fallback is wording for an unknown event, not wording a client has to repeat.
- These rows write **no `message_status` rows, by design**: an event never drives an unread badge and
  never appears in the pending-messages replay.
- They **do** become a chat's `last_message` in `GET /api/chats`, and when the newest row is an event
  `get_chats_info()` emits the full `system_frame()` shape there too (`type: "system"`, `event`,
  names), so the sidebar can tell an event from a message even on a cold boot. An ordinary
  `last_message` is still the short `{message_id, sender_id, message, time_sent}`.
- The person who left does **not** get their own `member_left` frame and won't see it in history —
  they are no longer a member. That is intentional.

The sender is always the session's `user_id`: `websocket_endpoint` derives `client_id` from the
JWT and passes it down, and the frame's own `client_id` field (still sent by the old harnesses) is
never read.

**Known gap — one socket per user.** `WebsocketManager.connect()` returns `None` when
`client_id` is already in `active_connections`, and `websocket_endpoint` has already called
`websocket.accept()` by then, so it `return`s on a duplicate **without closing the socket and
without ever reading from it**. The client sees `onopen` and `WS.isOpen() === true` while every
frame it sends goes nowhere and nothing is ever fanned out to it. Reproduce it by opening the app
in two tabs as the same user: the second tab is silently dead, and reconnecting doesn't help
because the first tab still holds the slot. It also fires transiently when a reconnect races the
old handler's `finally: disconnect()`. The frontend can only make it visible, not fix it —
`app.js` toasts and forces a reconnect when a send goes unacked for `ACK_TIMEOUT_MS`.


### Database (`app/db.py`)

One `Database` singleton (`connection`) wrapping an `aiomysql` pool created in `main.py`'s startup
hook. The pool is `autocommit=False` and every method goes through the `_transaction()` async
context manager, which yields a cursor, commits on clean exit and rolls back on any exception — so a
multi-statement write is atomic. Use `%s` placeholders. All SQL lives here; routers never talk to
the driver directly.

Schema (`database/migrations/`, applied by `database/migrate.py`; `schema.sql` is gone):
`users`, `chats`, `chat_users` (join), `messages`, `message_status` (per-recipient delivery state,
the basis of offline delivery). `messages` is **not** messages-only: `004_system_messages.sql` adds
`kind ENUM('user','system') NOT NULL DEFAULT 'user'`, `event VARCHAR(32) NULL` and `target_id INT
NULL` (FK → `users`), plus `event_data JSON NULL` from `005_system_event_data.sql`, so a
membership/role event is a row in the same table — it inherits ordering,
pagination, `last_message` and pubsub fan-out for free. On a system row `sent_by` is the actor and
`target_id` the person it is about (the same person for a self-initiated leave); on a normal row both
extra columns are `NULL`. Only `get_chat_message()` and `insert_system_message()` read or write them,
and nothing writes `message_status` for a system row. `chats.dm_key` is a
nullable `UNIQUE` column holding `"{lo}-{hi}"` of the two sorted member ids for a DM and `NULL` for
a group — MySQL allows unlimited `NULL`s in a unique index, so DMs are deduped by the DB while
groups are not. `chat_users.role` (`admin`/`user`) backs `check_user_role()` and `get_admin_count()`,
and both it and `chats.is_dm` are selected by `get_chats_info()`, so `GET /chats` exposes them.

**Database init and migrations.** The schema lives in `database/migrations/NNN_*.sql`, applied in
order by `database/migrate.py`, which records each in a `schema_migrations` ledger table so it runs
exactly once. The backend's `entrypoint.sh` runs it before starting uvicorn, so **a schema change is a
new numbered migration file, not an edit to an old one**, and it applies on the next backend
container start — no volume drop. `uvicorn --reload` restarts only the app, not the entrypoint, so a
code reload does *not* apply a new migration; restart the `backend` container, or run
`python database/migrate.py` from the host (it picks `127.0.0.1:3307` when `APP_ENV` isn't `DOCKER`).

The only SQL still under `/docker-entrypoint-initdb.d/` is `init-db.sql` (DB user + seed admin),
which MySQL runs only when the `chatapp-db` volume is empty — so an `init-db.sql` change still needs
`docker_rebuild.sh`. `database/Dockerfile` (dev) no longer loads `testdata.sql` (the line is commented
out). **`database/Dockerfile.prod` still does `COPY schema.sql`, which no longer exists, so building
the prod DB image fails** until it's switched to the migrations flow.

### Frontend (`static/`)

Plain HTML/CSS/JS, no build step or framework; nginx bind-mounts the directory so edits are live.
Built to `FRONTEND_SPEC.md` — read that for the API/WS shapes and the data-mapping rules; the
"v2 changes" note at the top of that file lists where the shipped UI has moved past it.

- `index.html` + `css/app.css` — two-pane shell (sidebar + chat + composer): a neutral grey ramp
  (`--ink`/`--ink-soft`/`--ink-faint`, `--subtle`, `--line`), one blue `--accent` with a near
  shade `--accent-2` used only for subtle gradient ends (logo, sent bubbles, send button,
  badge), Inter for UI and Bricolage Grotesque (`--display`) for the wordmark, chat title, dialog
  and empty-state headings. The speech-bubble corner (one tight radius bottom-left) recurs on the
  logo mark, empty-state tile and login mark. Avatars are pastel tiles: `hueFor()` in `app.js`
  returns only a hue, set as `--h`, and the `--avatar-bg-*`/`--avatar-fg-*` tokens theme it.
  All colour is tokens on `:root` with the dark theme redefining the same tokens in one
  `prefers-color-scheme` block; `body[data-view]` toggles the single-pane mobile layout.
  The chat header and the composer are solid bars absolutely positioned over the message list,
  so `.messages` reserves `--head-h` at the top and `--composer-h` (kept current by a
  `ResizeObserver`) at the bottom. **Nothing may be added to `.composer` in flow**: its
  `offsetHeight` *is* `--composer-h`, so anything that appears and disappears there moves the
  bottom of the message list and jumps the conversation. (The typing indicator used to be such a
  thing, `.typing` pinned out of flow above the pill to dodge exactly that; it is now a bubble in
  `#messages` instead and `.composer` holds only the pill and `.sending-hint`, which is always
  either present or hidden by `state.sending` rather than by somebody else's keyboard.)
  `.typing-msg` is that bubble: a `.msg.theirs` row like a received message, `.typing-faces`
  (overlapping `avatar-sm` tiles plus the header's `.stack-more` for "+N") beside a
  `.bubble.typing-bubble` whose only content is `.typing-dots`, still driven by the one
  `@keyframes typingPulse`. Being *inside* the scroll container is what makes it safe: the
  composer's height never changes, and growing or shrinking the list from the bottom is a problem
  the list already knows how to solve (see `nearBottom()` under `js/app.js`).
  `.app` needs `grid-template-rows: minmax(0,1fr)` and `min-height: 0` on both panes or the inner
  scroll containers stop scrolling. Two `<template>` elements hold the empty-state line icons, because
  the `el()` helper uses `createElement` and can't build namespaced SVG. `.sys` (membership/role
  event lines) is a hairline-flanked centred row using only `--ink-soft` / `--line`, the same pair
  `.meta` and `.day` already use, so it needs no dark-mode rule of its own.
  `.sr-only` is the clip-path-based visually-hidden helper (never `display: none`, which would
  leave the accessibility tree too); it carries `#typingStatus`'s sentence and the purpose of the
  two identity controls below.
  The chat header's avatar + title + subtitle is one control, `.chat-id-btn`, wrapped in an
  `<h1 class="chat-head-id">` rather than the other way round — a heading is flow content and isn't
  valid inside a `<button>`, so this keeps the pane's heading *and* makes the whole block
  clickable. Its `margin-left: -8px` pulls its own padding back out so the avatar stays where it
  was; under 768px that is dropped, because the back button is in that space. The sidebar foot's
  `.me-btn` is the same idea for your own row.
- `js/api.js` — `API.apiFetch()` adds the `/api` prefix and `credentials: "include"`; a **401**
  triggers one single-flight `POST /api/refresh` and a retry, else redirects to `/login/`. A 403 is a
  permission answer and passes straight through to the caller (see "401 vs 403" under Auth).
  `API.searchUsers(q, { limit, signal })` wraps `GET /api/users?q=`. The membership calls each match
  their endpoint's own shape, and the asymmetries are the backend's, not bugs to fix:
  `deleteChat(chatId)` posts a JSON body, `changeRole(chatId, userId, newRole)` posts **query
  params**, `addMembers(chatId, userIds)` puts `chat_id` in the **path** and a **bare array** in the
  body (never wrapped in an object), `leaveChat(chatId)` is a path param with **no body at all**,
  and `kickMember(chatId, userId)` is a path param **plus** a `user_id` query param.
  `changePassword(old, next, confirm)` is an ordinary JSON body and always sends all three fields,
  `old_password` included, even though the server ignores its value today.
- `js/ws.js` — `WS.connect()` to `ws://<host>:8000/ws` (direct, not via nginx), backoff
  reconnect (runs `API.getMe()` first so an expired session is refreshed before the handshake),
  routes the eleven inbound frame shapes (`message`/`system`/`ack`/`error`/`chat_created`/
  `chat_deleted`/`chat_renamed`/`member_added`/`member_removed`/`user_typing`/type-less pending
  map). Outbound it offers exactly two senders: `sendMessage()` and `sendTyping()` — see "Typing"
  under the messaging pipeline for why typing needs its own, and why it carries no `user_id`.
- `js/app.js` — `state`, rendering, events, boot. Own messages render only on the echoed
  `message` frame (never optimistically), and an event line only on the `system` frame or on
  history — nothing is synthesized locally when you act. Unread counts are client-side after boot;
  "older" pages use `offset = loaded count`. A `chat_created` frame triggers `refreshChats()` when the chat
  is unknown. Scripts load in order: api → ws → app.
  - `parseTime(s)` is the single entry point for every timestamp: it takes a `Date`, ISO with an
    offset, or ISO without one (treated as naive UTC), normalises the fractional seconds to the
    three digits `Date` is specified to accept, expands a compact `+0000` offset, and returns an
    Invalid Date instead of throwing. `fullStamp()` builds the `title` tooltips (full local date,
    time and zone abbreviation) on `.meta` timestamps and sidebar times.
  - `avatarEl()` is the one avatar: a hued initials circle, overlaid by `<img>` when `avatar_url`
    is set, with the image removing itself on error. DM avatars are hued by the other person, not
    the chat, so a face looks the same in the picker, the sidebar and the header.
  - An unacked send after `ACK_TIMEOUT_MS` toasts and forces a reconnect — see the duplicate-socket
    gap under "Messaging pipeline".
  - **Membership/role events in the timeline.** A `system` frame goes into
    `state.messagesByChat` through the same `storeIncoming()` / `liveBuffer` / `time_sent`-sorted
    path as a message, and `renderMessages()` draws live and historical copies with the one
    `systemLineEl()` — a centred `.sys` divider line, never a bubble and never an avatar — so a
    reload looks like what the user just watched happen. It deliberately does **not** bump
    `unread_message_count` (there is no `message_status` row behind it). An event becomes `prev` in
    the render loop and carries no `sender_id`, so it always breaks bubble grouping on both sides
    (the run before it gets its `group-end` timestamp, the run after it a fresh `group-start`); and
    because the server pages system rows in the same `time_sent DESC` window as messages, the
    `offset = loaded count` pagination needs no adjustment. `systemText()` is the only copy writer:
    it builds the sentence from `event`/`actor_name`/`target_name`, says "You" where
    `state.me.user_id` matches `actor_id` or `target_id` ("You added Cleo", "Ada made you an admin",
    "You left"), and falls back to the server's `message` verbatim for an unknown `event`.
    `member_kicked` reads as "removed" in all three persons — "You removed Cleo" / "Ada removed you"
    / "Ada removed Cleo" — deliberately *not* the server's "kicked". The
    handler also calls `refreshChats()`, because this frame is the first notice a merely *watching*
    member gets that the roster moved. `systemLastMessage()` is the sidebar's half of it: it takes
    `last_message` as an event when it has `type: "system"` (which `GET /chats` now sends), and still
    falls back to the copy `bumpLastMessage()` wrote for a live frame or to the chat's loaded history
    from before the server sent that field; only an event drops the "Name: " prefix a preview gets.
  - **Typing indicators.** `state.typing` is `{ [chat_id]: { [user_id]: expiry timer } }` — the
    timer *is* the state, because the protocol has no `typing_stop` (see "Typing" above).
    `noteTyping()` (re)arms a `TYPING_TTL_MS` 5s timer per typist; `clearTypist()` /
    `clearTyping()` / `clearAllTyping()` each report whether they changed anything so an overtaken
    expiry doesn't re-render. Indicators are cleared on a chat switch and on any non-`open` socket
    status (both via `clearAllTyping()`), per-sender on their inbound `message`, and per-chat in
    `dropChat()`. Outbound, `maybeSendTyping()` runs on every composer `input` but is a leading-edge
    throttle: one frame per chat per `TYPING_SEND_MS` (3s), nothing on an empty composer, nothing
    while `wsStatus !== "open"`; `sendCurrent()` resets `typingOut` so the next burst announces
    immediately. `typingText()` is the one copy writer, first names only, ordered by user id (JS
    enumerates integer-like keys ascending) so names don't reshuffle: "Ada is typing…", "Ada and
    Cleo are typing…", "Ada and 2 others are typing…".

    **Where it is drawn.** For the open chat it is a **bubble at the end of the message list**, not
    a line above the composer: `typingBubbleEl()` builds a `.msg.theirs.group-start.group-end`
    row — the shape a received message has, with both group classes so the corner radii don't read
    as mid-run — holding the typists' faces and a `.bubble.typing-bubble` of three pulsing dots.
    It lives in `#messages` **because** anything in flow in `.composer` would move `--composer-h`
    and shift the whole conversation (see `index.html` + `css/app.css` above). That trade buys a
    new problem, scroll anchoring, and it is solved the way an incoming message already solves it:
    `nearBottom()` is the single "is the reader at the end" test (`BOTTOM_SLACK` 80px, also used
    for `renderMessages()`'s `wasAtBottom`), and `renderTyping()` only calls `scrollToBottom()`
    when it was true *before* the bubble appeared or disappeared. `renderMessages()` wipes the
    list, so it re-appends the bubble itself (`appendTypingBubble()`), before its own scroll
    decision so `"bottom"`/`"stick"` land past it.
    **One bubble per chat, however many typists** — N stacked bubbles would push the conversation
    up the screen and turn a hint into an event. Up to `STACK_MAX` (3) overlapping `avatar-sm`
    faces, then "+N" via the header's `.stack-more`. The node carries `data-typists` (the ascending
    id list it was built from), and `renderTyping()` leaves an unchanged bubble in place rather
    than replacing it, so the dots don't restart every time a typist re-announces (every 3s, per
    person).
    **Accessibility.** The bubble is `aria-hidden` — it is three dots and says nothing. `#typingStatus`
    is the spoken half: a permanent `role="status"` `.sr-only` element whose text `renderTyping()`
    sets to `typingText()`, written only when the sentence actually differs so an unchanged state
    can't re-announce. A live region that is *added* with its content is unreliable; one that is
    always there and changes is not. So `typingText()` has two consumers, not one: this live region
    and `renderChatList()`, which still uses the sentence verbatim as a background chat's preview
    line.

    The `error` handler swallows `detail === "Something Went Wrong"` — the server's wording for a
    refused control frame, and `typing` is the only control frame this client sends — so a typing
    frame that didn't land neither toasts nor gets counted against a message awaiting its `ack`.
  - **Removing a member (kick).** `memberRow()` adds a `.row-action.caution` "Remove" beside "Make
    admin", only when `amAdmin(chat) && !isDm(chat)` and the row is a plain member who isn't you —
    exactly where the server will accept it (your own row uses "Leave group" in the footer instead).
    It goes through `openConfirm()` like "Step down" and "Leave group", and `kickMember()` mirrors
    `applyRole()`: it returns `null` on success or the message to show, so a `403` keeps the dialog
    open and explains itself through `FRIENDLY` ("Admins can't be removed. Demote them first, then
    remove them."), and a `404` is treated as "already out" — refresh quietly. On success it must
    `await refreshChats()`, because the acting admin gets *neither* of the kick's frames and
    `GET /chats` is the only roster. Nothing is drawn locally: the removed member's own client acts
    on `member_removed` (`dropChat()`), and the event line comes from the `member_kicked` system
    frame like any other.
  - `dropChat(chatId)` is the single teardown for a chat that no longer exists: it drops the sidebar
    entry and the `messagesByChat` / `hasMoreByChat` / `loadingHistory` / `liveBuffer` / typing /
    hidden-DM entries, closes the conversation-info dialog if it was showing that chat, and clears
    the selection back to the empty state. It is **idempotent and returns whether the chat was
    known**, because the
    `chat_deleted` frame also reaches the deleter, who has usually cleaned up after its own `200`;
    the `deleting` set keeps the frame from toasting over the deleter's own message when it wins the
    race. `loadHistory()` re-checks `findChat()` after its `await` for the same reason.
  - **Locally hidden DMs.** A DM can't be deleted server-side, so "Delete for me" hides it in this
    browser only: `localStorage["chatapp.hiddenDms"]` maps `chat_id` → the chat's `last_message`
    `time_sent` at the moment it was hidden, `visibleChats()` filters those out of the sidebar, and
    every read/write is wrapped (`localStorage` throws in private mode and with site data blocked —
    with it unavailable the hide simply lasts only for the life of the page). Hiding is per-browser
    by design and is "clear it for now", not a block: `unhideDm()` brings a DM back on an inbound
    `message` frame, on a pending-messages replay, when the chat is opened deliberately, and on any
    refresh where `unread_message_count > 0` or `last_message` is newer than the stored watermark.
- `login/` — sign-in / create-account card; branches on HTTP status, not message strings.
- **New conversation** is a real people picker (`#newChatDialog`): debounced 150 ms search against
  `GET /api/users?q=` with an `AbortController` per keystroke, stale responses dropped by comparing
  the query against the field, keyboard nav (↑/↓/Enter/Esc, Backspace removes the last chip), and
  removable chips. One person selected is a DM, two or more a named group. `POST /create_chat`
  returns `{chat_id}`, so `submitNewChat()` refreshes the list for the chat's members and opens it
  by id (`openCreatedChat()`) — no id guessing. **Only that path selects a new chat**; the
  `chat_created` control frame just calls `refreshChats()` when the chat is unknown, so the frame
  and the POST response can land in either order without double-selecting. Duplicate DMs are
  rejected server-side (`chats.dm_key` is `UNIQUE`) with **409 `chat already exists`**, which the
  catch treats as success: refresh, then open the DM with that person (`findDmWith()`), falling back
  to a readable message if it still isn't there. The client-side pre-check at the top of
  `submitNewChat()` now only saves that round trip. Groups are deliberately *not* deduped, server-
  side or client-side. `findDmWith()` matches on `is_dm`, so a two-person *group* containing that
  person is no longer mistaken for the DM with them.
  - **One picker, two flows.** `#newChatDialog` and its whole search pipeline are shared with "Add
    people": `picker.mode` is `"new"` or `"add"` (plus `picker.chatId` for the target group), and
    `openPeoplePicker()` is the single entry point behind `openNewChat()` and `openAddPeople()`.
    Only the dialog title, the group-name row, the submit label and `submitPicker()`'s branch differ
    — the debounce, the `AbortController` per keystroke, the stale-response drop, the chips and the
    keyboard nav are not duplicated. In `"add"` mode `alreadyInChat()` marks existing members
    "Already in" and makes them unselectable (the search endpoint only excludes the caller), and the
    400's interpolated id is turned back into a name by `addProblem()`.
- **Conversation menu** (`#chatMenu` in the chat header) is built per chat by `renderChatMenu()`.
  In a group every member gets "Members & roles" and "Leave group"; an admin also gets "Add people",
  "Rename group" and "Delete group". A DM gets only "Delete for me" (it has no admin, and the server refuses both
  deleting and leaving one). Destructive and significant items go through one `#confirmDialog`, whose
  `onOk` returns `null` on success or a message to show in place (so a `403` keeps the dialog open and
  explains itself). The server's `403` details are rewritten through the `FRIENDLY` map; leaving
  overrides the shared last-admin detail with its own actionable line ("You're the only admin. Make
  someone else an admin in “Members & roles” before you leave."), and `askLeave()` /
  `askStepDown()` pre-warn with the same guidance when `amSoleAdmin()` already knows. `leaveGroup()`
  mirrors `deleteGroup()`: a `leaving` Set keeps the echoed `member_removed` frame from toasting over
  it, and it calls `dropChat()` itself rather than waiting on the frame.
- **Rename** (`#renameDialog`) is admin-only and group-only, reached from the kebab's "Rename group"
  **and** from `#membersRename` in the info panel's head (both call `openRename(chat)`, which
  re-checks `isDm` / `amAdmin` so a stale roster can't open it where the server would refuse).
  It is prefilled with the current name and
  reuses the picker's `.group-name` field. It trims and refuses an empty name, because the server
  accepts any string including `""` and would blank the group's name, and it short-circuits when the
  name is unchanged rather than posting a no-op. The new name is **never applied locally** — a 200
  only means it committed, and the `chat_renamed` frame is what moves the sidebar row, the header and
  the open panel, so every client including this one updates from one place (the same rule as a
  message rendering on its echo). A 403 keeps the dialog open with the `FRIENDLY` wording and kicks
  off a `refreshChats()`, since it usually means our roster or our own role is stale.
- **Two ways into the info card, and the header is one of them.** The chat header's avatar + title +
  subtitle is an activatable control (`#chatInfoBtn`, named "Conversation info" through an `.sr-only`
  span) that opens `#membersDialog`. The kebab is **unchanged** — this is an additional door, not a
  replacement, and it is the *only* door for a DM, whose menu has no "Members & roles" item. Both
  land in the same `openMembers()`, which reads `state.activeChatId`.
- **Conversation info** (`#membersDialog`, `.dialog.panel`; `openMembers()` / `renderMembers()`) is
  the management surface for **both** kinds of conversation. The names still say `members` — the
  panel grew into the DM case rather than being replaced, and renaming nine ids plus every reference
  would be churn with no behaviour behind it, so read `members*` as "conversation info".
  Shared frame: a head (avatar, name, `.panel-sub`), one `.panel-note` saying what you can do here,
  the roster, then `.panel-actions`.
  - **A group** is what it always was: sub is "N members · N admins"; the roster is **grouped by
    role** (`Admins` / `Members` sections with a count), so no row repeats its own role badge — that
    per-row uppercase pill is what made the old flat list noisy. Row actions are deliberately
    unequal: "Make admin" is an outlined `.row-action` button, while "Demote"/"Step down"/"Remove"
    are `.row-action.caution` — borderless text that only turns `--error` under the cursor — so the
    significant action no longer reads like the benign one. A plain member's row can carry two of
    them, so they travel together in one `.roster-actions` group pinned right; several
    `margin-left: auto` siblings would each claim a share of the row's free space and drift apart.
    Footer: "Leave group" quiet on the left, "Close" and "Add people" on the right, "Add people"
    hidden for non-admins. An admin also gets **`#membersRename` ("Rename") in the head**, next to
    the name it changes rather than competing with the footer's exits; it opens `#renameDialog` on
    top of this panel, which stays underneath. The kebab's "Rename group" stays too.
  - **A DM** is the same frame with everything role-shaped removed, because a DM has no admin (both
    members are `role: "user"`) and the server refuses to rename, delete or leave one. Sub is
    "Direct message"; the note says so in as many words. The roster is **one flat two-person list**
    — `rosterGroup()` takes a `null` caption for it, because "Members 2" over exactly you and them
    reads like a group — with no row actions at all (`memberRow()` already draws none once
    `iAmAdmin` is false; it is checked, not assumed). "Add people", "Leave group" and "Rename" are
    hidden, and the one destructive action is **"Delete for me"** (`#membersDelete`), wired to the
    existing local-hide path (`askDelete()` → `hideDmLocally()` → `localStorage["chatapp.hiddenDms"]`).
    There is no server call behind it and there must not be one. Hiding also closes this panel,
    since the conversation it is about just left the list — but **not** via `dropChat()`, which is
    for a chat that no longer exists.
  - Opening it focuses "Add people" (or "Close" when that is hidden, i.e. a non-admin or any DM)
    rather than letting `<dialog>` pick the Leave/Delete button. "Step down", "Remove", "Leave
    group" and "Delete for me" open `#confirmDialog` on top of this panel, and "Add people" and
    "Rename" open their own dialogs on top of it; all of them leave it in place underneath. Roles
    and membership only come from `GET /chats`, so every successful change is followed by
    `refreshChats()`, which re-renders this panel *and* the header (a self-demotion has to remove
    "Delete group" immediately).
- **Profile card** (`#profileDialog`, `openProfile()`), opened by `#meBtn` — the sidebar foot's
  avatar + name, now a control; the `#logoutBtn` icon beside it still logs out in one click. It
  shows the `avatar-xl` tile, `display_name` and `@user` straight from `state.me` (`GET /me`), plus
  one "Log out" action that shares `logout()` with `#logoutBtn` (both are disabled on click so a
  second one can't race the redirect). Focus lands on "Close", never "Log out".
  **Your name and picture are read-only, and that is not an oversight: there is no endpoint behind
  an edit form.** `POST /profile` in `app/routers/users.py` got as far as validating the body and
  assigning `display_name`/`avatar_url` to two locals with no DB write, and is now **commented out
  entirely**, so the route doesn't exist. Don't add a name/avatar form here, or an
  `API.updateProfile()` to `api.js`, before the endpoint is uncommented *and* finished.
  The password is the exception — `POST /passwordchange` works — so the card's one real action is
  **"Change password"** (`#profilePassword`), which opens `#passwordDialog` on top of it, the same
  stacking `#renameDialog` uses over the info panel.
- **Change password** (`#passwordDialog`, `openPassword()` / `submitPassword()`). Three
  `type="password"` fields; `.dialog input[type="text"]` was extended to cover `[type="password"]`,
  or they would have rendered as unstyled browser defaults. `PW_RULE` is the server's `rgx`
  **copied verbatim** and `PW_HINT` the single wording for it, used by the hint line under the
  field, by the local failure *and* as the `FRIENDLY` rewrite of the server's own
  `Password does not meet the requirement`. It is mirrored, not owned: the server re-checks
  everything, this only saves a round trip and lets the requirement be stated before you type.
  `"Password Missmatch"` is a `FRIENDLY` key spelled with the server's typo, byte for byte, or the
  rewrite silently wouldn't fire.
  - **Nothing is trimmed, anywhere.** Whitespace is part of a password and the server's rule
    rejects it everywhere, so trimming would turn a password the server refuses into a different
    one it accepts — and the user then couldn't log in with what they typed.
  - Fields are validated in reading order (current → both new → rule → match) so the message always
    points at the first field needing attention, and each failure focuses it. This checks the rule
    *before* the match where the server checks the match first; both are caught locally, so the
    server's order never surfaces, and pointing at the password that has to change is the better of
    the two.
  - On success it closes, toasts, and says **nothing about other devices**: the change revokes no
    tokens (see `POST /passwordchange` under Auth), so this session and every other one stay valid.
    The dialog's `close` handler wipes all three fields, so a typed password doesn't outlive the
    dialog in the DOM whether it was cancelled, Esc'd or submitted.
  - It asks for the current password because the server's model requires the field, **not** because
    the server verifies it — it doesn't. Don't write copy here implying it was checked.
- **Membership frames.** `member_added` means *you* were added, possibly to a chat this client has
  never seen, so the handler refreshes and toasts only when the chat really is new. `member_removed`
  means *you* are out and reuses the idempotent `dropChat()` path, `leaving`-guarded like
  `chat_deleted` — it now covers being kicked as well as your own leave, and the frame doesn't say
  which, so the toast ("You're no longer in “X”") reads for both. Because neither frame reaches the
  *other* members (see "Membership frames, and what they don't tell you"), the acting admin
  refreshes by hand after its own `200` — that is why `submitAddPeople()` and `kickMember()` await
  `refreshChats()`.
- **`chat_renamed`.** The handler patches `chat.chat_name` in place and re-renders the sidebar, the
  header and the conversation-info panel, falling back to `refreshChats()` for a chat it doesn't
  know. It is the *only* thing that applies a new name in this client — neither rename entry point
  (the kebab item, `#membersRename` in the panel head) touches `chat_name` itself.
- `client1.html` / `client2.html` remain as bare WS harnesses.

## Entrypoint scripts

`app/Dockerfile` copies **`entrypoint.sh`** to `/dev_entrypoint.sh` — the file named
`dev_entrypoint.sh` in the repo is not the one that runs. The active script runs
`uvicorn main:app --reload` with workdir `/app`, which is why backend modules import flatly
(`from db import connection`, `from routers.users import verify_jwt`) rather than as an `app.`
package. `prod_entrypoint.sh` (`fastapi run`) is unused by the current Compose file.
