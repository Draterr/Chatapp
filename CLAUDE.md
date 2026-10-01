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
the client re-reads `GET /chats` after every role change, add or leave.

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
success it publishes a `remove_member` control frame. There is no "remove someone else" endpoint, so
`remove_member` only ever describes the caller leaving.

Note: these business-logic `403`s collide with `API.apiFetch()`'s refresh interceptor, which treats
*any* 403 as an expired access token: it runs one `POST /api/refresh` (rotating the token pair) and
retries the request once before surfacing the error. The second attempt is refused the same way, so
the detail the user sees is right — it just costs a wasted refresh and a duplicate request. This
predates `add_member`/`leave` (`delete_chat` and `change_role` behave the same) and is not worth
chasing until the backend uses 401 for auth.

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

- `event` is exactly one of `member_added`, `member_left`, `promoted`, `demoted`.
- Leaving is self-initiated, so `member_left` has **`actor_id == target_id`** (and the same name in
  both fields); the other three have an actor acting on someone else.
- `message` is a server-rendered fallback sentence (`"Ada added Cleo"`, `"Cleo left"`, `"Ada made
  Cleo an admin"`, `"Ada removed Cleo as an admin"`). A client that knows the `event` should build
  its own copy from `actor_name`/`target_name` (so it can say "You"); the fallback is for an `event`
  it doesn't recognise, so a future event still renders as *something*.
- These rows write **no `message_status` rows, by design**: an event never drives an unread badge and
  never appears in the pending-messages replay.
- They **do** become a chat's `last_message` in `GET /api/chats` — but that payload carries only
  `message_id`/`sender_id`/`message`/`time_sent`, with no `kind` or `event`, so the sidebar can't
  tell an event from a message there. See the `systemLastMessage()` note under `js/app.js`.
- The person who left does **not** get their own `member_left` frame and won't see it in history —
  they are no longer a member. That is intentional.

Note: the send path trusts the client-supplied `client_id` in the frame instead of the session's;
this is a known gap, tracked as item #5 in the `chat.js` integration comments.

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
NULL` (FK → `users`), so a membership/role event is a row in the same table — it inherits ordering,
pagination, `last_message` and pubsub fan-out for free. On a system row `sent_by` is the actor and
`target_id` the person it is about (the same person for a self-initiated leave); on a normal row both
extra columns are `NULL`. Only `get_chat_message()` and `insert_system_message()` read or write them,
and nothing writes `message_status` for a system row. `chats.dm_key` is a
nullable `UNIQUE` column holding `"{lo}-{hi}"` of the two sorted member ids for a DM and `NULL` for
a group — MySQL allows unlimited `NULL`s in a unique index, so DMs are deduped by the DB while
groups are not. `chat_users.role` (`admin`/`user`) backs `check_user_role()` and `get_admin_count()`,
and both it and `chats.is_dm` are selected by `get_chats_info()`, so `GET /chats` exposes them.

**Database init:** SQL under `/docker-entrypoint-initdb.d/` only runs when the `chatapp-db` volume
is empty, so any change to `schema.sql` / `init-db.sql` / `testdata.sql` needs the volume dropped —
that is what `docker_rebuild.sh` is for. `database/Dockerfile` (dev) also loads `testdata.sql`;
`Dockerfile.prod` does not.

### Frontend (`static/`)

Plain HTML/CSS/JS, no build step or framework; nginx bind-mounts the directory so edits are live.
Built to `FRONTEND_SPEC.md` — read that for the API/WS shapes and the data-mapping rules; the
"v2 changes" note at the top of that file lists where the shipped UI has moved past it.

- `index.html` + `css/app.css` — two-pane "warm editorial" shell (sidebar + chat + composer).
  All colour is tokens on `:root` with the dark theme redefining the same tokens in one
  `prefers-color-scheme` block; `body[data-view]` toggles the single-pane mobile layout.
  Inter (UI) and Fraunces (display: wordmark, chat title, dialog and empty-state headlines) load
  from Google Fonts with real fallback stacks. The chat header is a `backdrop-filter` strip the
  messages scroll under and the composer floats over them, so `.messages` reserves
  `--head-h` at the top and `--composer-h` (kept current by a `ResizeObserver`) at the bottom.
  `.app` needs `grid-template-rows: minmax(0,1fr)` and `min-height: 0` on both panes or the inner
  scroll containers stop scrolling. Two `<template>` elements hold the empty-state SVGs, because
  the `el()` helper uses `createElement` and can't build namespaced SVG. `.sys` (membership/role
  event lines) is a hairline-flanked centred row using only `--ink-soft` / `--line`, the same pair
  `.meta` and `.day` already use, so it needs no dark-mode rule of its own.
- `js/api.js` — `API.apiFetch()` adds the `/api` prefix and `credentials: "include"`; a 403
  triggers one single-flight `POST /api/refresh` and a retry, else redirects to `/login/`.
  `API.searchUsers(q, { limit, signal })` wraps `GET /api/users?q=`. The membership calls each match
  their endpoint's own shape, and the asymmetries are the backend's, not bugs to fix:
  `deleteChat(chatId)` posts a JSON body, `changeRole(chatId, userId, newRole)` posts **query
  params**, `addMembers(chatId, userIds)` puts `chat_id` in the **path** and a **bare array** in the
  body (never wrapped in an object), and `leaveChat(chatId)` is a path param with **no body at all**.
- `js/ws.js` — `WS.connect()` to `ws://<host>:8000/ws` (direct, not via nginx), backoff
  reconnect (runs `API.getMe()` first so an expired session is refreshed before the handshake),
  routes the nine inbound frame shapes (`message`/`system`/`ack`/`error`/`chat_created`/
  `chat_deleted`/`member_added`/`member_removed`/type-less pending map).
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
    "You left"), and falls back to the server's `message` verbatim for an unknown `event`. The
    handler also calls `refreshChats()`, because this frame is the first notice a merely *watching*
    member gets that the roster moved. `systemLastMessage()` is the sidebar's half of it: since
    `GET /chats` sends `last_message` with no `kind`/`event`, it recovers the marker from the copy
    `bumpLastMessage()` wrote for a live frame (carried across a refresh in `refreshChats()`) or from
    the chat's loaded history, and only then drops the "Name: " prefix an ordinary preview gets.
  - `dropChat(chatId)` is the single teardown for a chat that no longer exists: it drops the sidebar
    entry and the `messagesByChat` / `hasMoreByChat` / `loadingHistory` / `liveBuffer` / hidden-DM
    entries, closes the members dialog if it was showing that chat, and clears the selection back to
    the empty state. It is **idempotent and returns whether the chat was known**, because the
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
  In a group every member gets "Members & roles" and "Leave group"; an admin also gets "Add people"
  and "Delete group". A DM gets only "Delete for me" (it has no admin, and the server refuses both
  deleting and leaving one). Destructive and significant items go through one `#confirmDialog`, whose
  `onOk` returns `null` on success or a message to show in place (so a `403` keeps the dialog open and
  explains itself). The server's `403` details are rewritten through the `FRIENDLY` map; leaving
  overrides the shared last-admin detail with its own actionable line ("You're the only admin. Make
  someone else an admin in “Members & roles” before you leave."), and `askLeave()` /
  `askStepDown()` pre-warn with the same guidance when `amSoleAdmin()` already knows. `leaveGroup()`
  mirrors `deleteGroup()`: a `leaving` Set keeps the echoed `member_removed` frame from toasting over
  it, and it calls `dropChat()` itself rather than waiting on the frame.
- **Group details** (`#membersDialog`, `.dialog.panel`) is the group-management surface, not a bare
  list: a head (group avatar, name, "N members · N admins"), one `.panel-note` saying what you can do
  here, the roster, then the footer actions ("Leave group" quiet on the left, "Close" and "Add
  people" on the right; "Add people" is hidden for non-admins). The roster is **grouped by role**
  (`Admins` / `Members` sections with a count), so no row repeats its own role badge — that per-row
  uppercase pill is what made the old flat list noisy. Row actions are deliberately unequal:
  "Make admin" is an outlined `.row-action` chip, while "Demote"/"Step down" is `.row-action.caution`
  — borderless text that only turns `--error` under the cursor — so the significant action no longer
  reads like the benign one. Opening it focuses "Add people" (or "Close" for a non-admin) rather than
  letting `<dialog>` pick the Leave button. "Step down" and "Leave group" open `#confirmDialog` on top
  of this panel, and "Add people" opens the picker on top of it; all three leave it in place
  underneath. Roles and membership only come from `GET /chats`, so every successful change is followed
  by `refreshChats()`, which re-renders this panel *and* the header (a self-demotion has to remove
  "Delete group" immediately).
- **Membership frames.** `member_added` means *you* were added, possibly to a chat this client has
  never seen, so the handler refreshes and toasts only when the chat really is new. `member_removed`
  means *you* are out and reuses the idempotent `dropChat()` path, `leaving`-guarded like
  `chat_deleted`. Because neither frame reaches the *other* members (see "Membership frames, and what
  they don't tell you"), the acting admin refreshes by hand after its own `200` — that is the only
  reason `submitAddPeople()` awaits `refreshChats()`.
- `client1.html` / `client2.html` remain as bare WS harnesses.

## Entrypoint scripts

`app/Dockerfile` copies **`entrypoint.sh`** to `/dev_entrypoint.sh` — the file named
`dev_entrypoint.sh` in the repo is not the one that runs. The active script runs
`uvicorn main:app --reload` with workdir `/app`, which is why backend modules import flatly
(`from db import connection`, `from routers.users import verify_jwt`) rather than as an `app.`
package. `prod_entrypoint.sh` (`fastapi run`) is unused by the current Compose file.
