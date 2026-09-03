# Frontend Build Spec

A complete, self-contained brief for building the chat app's frontend. Everything you need
is in this file — you do not need to read the conversation it came from. Read the backend
source under `app/` only to confirm details; the shapes below are authoritative as of writing.

---

## 0. Goal

Replace the mock-driven UI with a real one wired to the live FastAPI backend.
Vanilla JS/HTML/CSS. **No framework, no build step.** nginx bind-mounts `static/`, so edited
files are live on refresh — do not introduce a bundler, npm, or a compile step.

The existing `static/js/chat.js` is a finished *mock-driven* design (themes, modals, settings).
You are starting the visual layer fresh, so you may replace `static/index.html`, the CSS, and
the JS. Keep it plain `<script>` tags loaded in order.

---

## 1. Visual direction — "iMessage clean"

Bright, minimal, familiar. Two-pane desktop layout; single pane on mobile.

```
┌──────────────┬─────────────────────────────┐
│  My name  ⏻  │  Chat title                 │  ← header: title only (no presence)
│  ──────────  │  ───────────────────────────│
│ ● Jordan     │              Hey there! ┐   │  ← received: grey, left
│   Maya       │   ┌ yea i agree           │  ← sent: blue, right
│   Design ②   │   └                        │
│              │        ┌──────────────────┐│
│              │        │ Message…      ➤ ││  ← pill composer + send
└──────────────┴────────┴──────────────────┴┘
```

**Design tokens** (define as CSS custom properties on `:root`):

| Token | Light value | Use |
|---|---|---|
| `--bg` | `#ffffff` | chat pane background |
| `--sidebar-bg` | `#f5f5f7` | conversation list |
| `--border` | `#e5e5ea` | dividers, hairlines |
| `--bubble-sent` | `#0b93f6` | my messages (text: `#fff`) |
| `--bubble-recv` | `#e9e9eb` | their messages (text: `#000`) |
| `--accent` | `#007aff` | send button, links, active states |
| `--text` | `#000000` | primary text |
| `--text-secondary` | `#8e8e93` | timestamps, last-message preview, presence |
| `--unread` | `#0b93f6` | unread count badge |

- **Font stack:** `-apple-system, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif`.
- **Bubbles:** `border-radius: 18px`, `padding: 8px 12px`, `max-width: 65%`, small timestamp
  in `--text-secondary` under or trailing the text. Group consecutive same-sender bubbles with
  a tight `3px` gap, `12px` gap when the sender changes.
- **Sidebar rows:** avatar circle (initials, hashed color) + name + last-message preview +
  time + unread badge. Active row highlighted.
- **Composer:** rounded pill textarea (auto-grows to ~5 lines), circular blue send button with
  an arrow. Enter sends, Shift+Enter = newline.
- **Day dividers:** centered small-caps "Today" / "Yesterday" / date between message groups.
- Provide a **dark theme** via `@media (prefers-color-scheme: dark)` if easy, but light is the
  priority. Do not build a theme-picker — keep it simple.

---

## 2. Runtime topology (critical)

- Frontend is served by nginx at **`http://localhost:8080`** (root = `static/index.html`).
- REST API is reached at **`/api/...`** on the same origin — nginx proxies `/api/` →
  `backend:8000/` and **strips the `/api` prefix**. So the browser calls `/api/login`, the
  backend route is `/login`. **Always call REST endpoints with the `/api` prefix.**
- **WebSocket is NOT proxied.** Connect directly to the backend port:
  `ws://localhost:8000/ws` (`wss://` if the page is https). Build the URL as
  `(location.protocol === "https:" ? "wss://" : "ws://") + location.hostname + ":8000/ws"`.
- **Auth is cookie-based** and automatic: the browser stores an httpOnly `session` cookie and
  sends it on same-origin REST calls and on the WS handshake. You never read or attach the
  token yourself. Use `fetch(..., { credentials: "include" })` on every API call.
- Cookies are marked `Secure`; this works on `http://localhost` because browsers treat
  localhost as a secure context. It will NOT work over a plain-http LAN IP.

---

## 3. Auth flow

### Cookies the backend sets (httpOnly — JS cannot read them)
- `session` — the access JWT. Path `/`. Expires in 10 hours. Sent on all `/api/*` and `/ws`.
- `refresh_token` — opaque refresh token. **Path `/api/refresh`** (so it is sent *only* to the
  refresh endpoint). Expires in 7 days.

### Access-token refresh (build this as an interceptor)
The access token expires. When it does, protected endpoints return **403** (the backend's
`verify_jwt` returns `None` on an invalid/expired token and routes raise
`403 "Unauthorized"`). Wrap every protected API call in a helper:

```
apiFetch(path, opts):
  res = fetch("/api" + path, { ...opts, credentials: "include" })
  if res.status !== 403: return res
  // access token likely expired — try to refresh ONCE, single-flight
  ok = await refreshOnce()          // POST /api/refresh, credentials: include
  if !ok: redirect to /login/ ; throw
  return fetch("/api" + path, { ...opts, credentials: "include" })   // retry
```

- **Single-flight:** if several calls 403 at once, only one `POST /api/refresh` should be in
  flight; the rest await the same promise. Otherwise concurrent refreshes rotate the token
  against each other and all but one fail.
- `POST /api/refresh` succeeds with **200** and an empty/null body (it just rotates cookies).
  On an invalid/expired/absent refresh token it returns **404** or **403** — treat any
  non-2xx as "refresh failed → send the user to `/login/`".
- The refresh token is **single-use / rotating**: each successful refresh revokes the old one
  and issues a new one. Never fire two refreshes in parallel.

### Login page (`static/login/`)
- `POST /api/login` with JSON `{ "username": "...", "password": "..." }`, `credentials: include`.
  - **200** `{ "message": "Successfully Loggined!" }` → cookies are set; redirect to `/`.
  - **403** `{ "detail": "Incorrect username or password" }` → show error.
  - **400** `{ "detail": "username can't be empty" }` / `"password can't be empty"` /
    `"username has to be within 255 characters"` → validation error.
- `POST /api/register` with `{ "username", "password" }`.
  - **200** `{ "message": "Successfully Registed!" }` (note the backend's spelling) → then log in.
  - **400** `{ "detail": "username already exists" }`.
  - Registration takes only username + password; `display_name` defaults to the username.
- Branch on **HTTP status code**, not the message string.

### Logout
- `POST /api/logout`, `credentials: include`. Revokes refresh tokens server-side and clears both
  cookies. **200** `{ "message": "success" }`. Then redirect to `/login/`.
- Requires a valid session; returns **403** if already logged out.

---

## 4. REST API reference

All paths below are the **browser-facing** paths (include the `/api` prefix). All require the
session cookie unless noted. Error responses are FastAPI's `{ "detail": "..." }` with the status
code.

### `GET /api/me`
Own identity. Call first on boot; a **403** means "not logged in → redirect to `/login/`".
```json
{ "user_id": 12, "user": "alex", "display_name": "Alex Mercer", "avatar_url": null }
```
`user_id` is needed to decide which messages are "mine".

### `GET /api/chats`
The conversation list, already sorted by most-recent activity (newest first).
```json
{
  "data": [
    {
      "chat_id": "a1b2c3d4-...-uuid",
      "chat_name": "Design Team",
      "members": [
        { "user_id": 12, "display_name": "Alex Mercer", "avatar_url": null },
        { "user_id": 5,  "display_name": "Priya Nair",   "avatar_url": null }
      ],
      "unread_message_count": 5,
      "last_message": {
        "message_id": "…-uuid",
        "sender_id": 5,
        "message": "shipped the new icons",
        "time_sent": "2026-09-03T14:30:00.000000"
      }
    }
  ]
}
```
- `members` **includes yourself**.
- `last_message` is `{}` (empty object) for a chat with no messages yet — guard for it.
- `unread_message_count` is the count of `NOT-DELIVERED` rows for you in that chat.

### `GET /api/chat/{chat_id}/messages?limit=50&offset=0`
One chat's message history, **oldest → newest** within the returned page.
```json
{
  "data": [
    {
      "type": "message",
      "message_id": "…-uuid",
      "sender_id": 5,
      "sender_name": "Priya Nair",
      "message": "shipped the new icons",
      "time_sent": "2026-09-03T14:30:00.000000",
      "chat_id": "a1b2c3d4-...-uuid"
    }
  ],
  "has_more": true
}
```
- `limit` default 50, `offset` default 0.
- **Pagination is newest-first under the hood:** offset 0 returns the *latest* page; increase
  `offset` by `limit` to fetch *older* messages (for infinite scroll upward). `has_more: true`
  means older messages exist. Within each page, `data` is already reversed to oldest→newest for
  display, so prepend older pages above the current ones.

### `POST /api/create_chat`  (optional — see §7 gap)
```json
{ "chat_name": "Lunch", "chat_users": [5, 8], "is_dm": false }
```
- `chat_users` = other members' user_ids; your own id is added server-side.
- `is_dm: true` requires exactly one other user (400 otherwise).
- **200** `{ "Success": "Successfully Created Chat!" }`.
- There is **no user-search endpoint**, so you cannot pick members by name yet. See §7.

---

## 5. WebSocket protocol

### Connection
- URL: `ws://localhost:8000/ws` (direct, not through nginx — see §2).
- Auth: session cookie, sent automatically on the handshake. If the session is invalid the
  handshake is rejected (**403**) and no socket opens.
- Open the socket **after** `GET /api/me` succeeds.
- On close, **auto-reconnect** with a short backoff (e.g. `setTimeout(connect, 2000)`).
  On reconnect the backend replays anything you missed (see "pending" below).

### Outbound — sending a message (client → server)
Send exactly this shape:
```json
{ "type": "message", "message": "hello", "chat_id": "…-uuid" }
```
- **Do NOT send a sender id.** The server derives the sender from your session cookie
  (this closes a trust gap — the old mock sent a client-supplied id; don't).
- Only `type: "message"` is supported. Any other type gets an error frame back.

### Inbound frames (server → client)
Parse `JSON.parse(ev.data)` and branch. There are **four** shapes:

1. **Live message** — a new message in one of your chats (you receive this for chats you're a
   member of, **including your own sent messages echoed back**):
   ```json
   { "type": "message", "message_id": "…", "sender_id": 5, "sender_name": "Priya",
     "message": "hi", "time_sent": "2026-09-03T14:30:00.000000", "chat_id": "…-uuid" }
   ```
   Route by `chat_id` into your message store; if that chat is open, append + scroll.

2. **Ack** — confirmation that *your* just-sent message was persisted (sent only to you):
   ```json
   { "type": "ack", "content": { "message": "hello", "chat_id": "…-uuid" },
     "timestamp": "2026-09-03T14:30:00.000000" }
   ```

3. **Error** — something went wrong with your send:
   ```json
   { "type": "error", "code": "NOT_A_MEMBER", "detail": "User not part of Chat" }
   ```
   Codes: `NOT_A_MEMBER`, `DB_INSERT_ERROR`, `unsupported_message_type`.

4. **Pending-messages map** — sent once right after you connect, replaying messages that
   arrived while you were offline. **This frame has NO top-level `type`.** It is an object
   keyed by `chat_id`, each value an array of message frames:
   ```json
   {
     "a1b2c3d4-…": [
       { "type":"message", "message_id":"…", "sender_id":5, "sender_name":"Priya",
         "message":"you missed this", "time_sent":"…", "chat_id":"a1b2c3d4-…" }
     ]
   }
   ```
   Detect it by: `data.type === undefined` (not "message"/"ack"/"error"). Iterate the map and
   merge each array into the corresponding chat.

### The echo — avoid double-rendering
When you send a message you get back **both** an `ack` *and* a live `message` frame (the server
fans your own message out to every socket in the chat, including yours). Pick one strategy:
- **Simplest:** render only on the `message` frame (authoritative — it carries the real
  `message_id` and `time_sent`). Use the `ack` merely to clear a "sending…" spinner. Don't
  optimistically append on send, or you'll show the message twice.
- **Optimistic:** append immediately on send with a temp id, then when the echoed `message`
  frame arrives, reconcile/replace by matching content (there's no client-supplied id to match
  on, so matching is fuzzy — the simplest strategy above is recommended).

---

## 6. Data mapping (backend shape → UI)

The backend does not send display-ready fields. Derive them client-side:

- **`mine`** (is this my message?): `msg.sender_id === me.user_id`.
- **Chat title:**
  - DM (`members.length === 2`): the other member's `display_name` (the member whose
    `user_id !== me.user_id`).
  - Group (`members.length > 2`): `chat_name`.
  - Fallback: `chat_name`.
- **Avatar:** there is no image system yet (`avatar_url` is usually `null`). Render an initials
  circle: take the first letters of the title (1–2 chars). Give it a stable background color by
  hashing `chat_id` → an HSL hue, e.g.
  `hue = [...chat_id].reduce((h,c)=>c.charCodeAt(0)+((h<<5)-h),0) % 360; \`hsl(${hue} 45% 55%)\``.
- **Unread badge:** `unread_message_count` (hide when 0).
- **Timestamps** (see §6.1).

### 6.1 Time handling
- Every `time_sent` / `timestamp` string is **naive UTC** with no timezone suffix, e.g.
  `"2026-09-03T14:30:00.000000"`. Parse it as UTC: `new Date(iso + "Z")`. (If you don't append
  `Z`, browsers parse it as *local* time and everything is off by your UTC offset.)
- Formatting rules for display:
  - Same calendar day → `"5:37 PM"`.
  - Previous day → `"Yesterday"`.
  - Within the last 7 days → weekday (`"Mon"`).
  - Older → `"9/3/26"` or `"Sep 3"`.
- Sidebar shows the coarse form; message bubbles show `"5:37 PM"`.

---

## 7. Known gaps — do NOT build these (or stub them)

- **No presence system.** There is no online/last-seen data from the backend. Do **not** show
  online dots or "last seen" — leave the header title-only. (You may add a static • if purely
  decorative, but it means nothing.)
- **No user search / directory.** `create_chat` needs raw `user_id`s and there's no endpoint to
  look users up by name. So a real "New chat" flow can't pick people yet. Either omit the
  new-chat button, or (for testing only) a dev affordance that takes a raw user id. Note it as a
  backend TODO rather than faking it.
- **No message editing/deletion, reactions, typing indicators, or read receipts UI.** The
  `message_status` table tracks delivery server-side only; there's no API to surface it.
- **Avatars are initials only** until an upload/serving endpoint exists.
- **Group vs DM** is inferred from member count; there's no explicit flag on the chat object
  returned by `/api/chats`.

---

## 8. Suggested file layout

Plain scripts, loaded in this order at the bottom of `index.html`:

```
static/
  index.html            # chat shell: sidebar + chat pane + composer + modal root
  css/app.css           # all styles, tokens on :root
  js/api.js             # apiFetch() + refresh interceptor; getMe/getChats/getMessages/logout
  js/ws.js              # connect(), reconnect, inbound frame routing, sendMessage()
  js/app.js             # state, render(list/chat), event wiring, boot
  login/
    index.html          # login + register card
    login.css
    login.js            # POST /api/login, /api/register; branch on status
```

State shape suggestion (keep backend field names — no need for the old mock's shape):
```js
const state = {
  me: null,                 // { user_id, user, display_name, avatar_url }
  chats: [],                // array from GET /api/chats `data`
  activeChatId: null,
  messagesByChat: {},       // { [chat_id]: [ message frames, oldest→newest ] }
  ws: null,
};
```

### Boot sequence (`app.js`)
```
1. me = await getMe()               // 403 → location = "/login/"
2. render my name + logout in sidebar header
3. chats = await getChats()         // → state.chats; render conversation list
4. connectWebSocket()               // opens /ws; handles pending map + live frames
5. auto-select the first chat (or show an empty state if none)

selectChat(chat_id):
  if !messagesByChat[chat_id]: data = await getMessages(chat_id); store it
  render the chat pane; mark active; on mobile switch to the chat pane

sendMessage(text):
  ws.send({ type:"message", message:text, chat_id: state.activeChatId })
  (render on the echoed "message" frame — see §5 echo note)
```

### Responsive
- ≥ 768px: sidebar + chat side by side.
- < 768px: one pane at a time — list, then chat with a back button. A `body[data-view]`
  attribute toggling CSS is enough; no router needed.

---

## 9. Testing

- Start the stack: `docker compose up` (nginx :8080, backend :8000, mysql :3307, redis :6379).
- Seed data (`database/testdata.sql`) creates users and chats; user ids `2` and `3` are the
  pre-wired test clients. `static/client1.html` / `client2.html` are bare WS harnesses you can
  compare against.
- API explorer: `http://localhost:8000/docs`.
- Open the app at `http://localhost:8080`. Log in, and to test live delivery open a second
  browser/incognito window as a different user in the same chat — messages should appear in both
  in real time (they round-trip through Redis pub/sub).
- Refresh flow: the access token lasts 10h, so to exercise the interceptor you can shorten
  `ACCESS_TOKEN_EXPIRE_MINUTES` in `app/routers/users.py` temporarily.

---

## 10. Do / Don't checklist

- ✅ `credentials: "include"` on every fetch.
- ✅ `/api` prefix on REST; bare `:8000/ws` for the socket.
- ✅ Parse `time_sent` as UTC (`+ "Z"`).
- ✅ `mine = sender_id === me.user_id`.
- ✅ Single-flight refresh on 403, retry once, else → `/login/`.
- ✅ Handle the four WS frame shapes, including the type-less pending map.
- ✅ Render sent messages on the echoed frame, not optimistically (avoids duplicates).
- ❌ Don't send a sender id in the WS frame.
- ❌ Don't add a build step / framework / bundler.
- ❌ Don't invent presence, read receipts, or user search — they have no backend.
- ❌ Don't branch on login/register *message strings* — use status codes.
