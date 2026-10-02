/* ws.js — WebSocket connection, reconnect, inbound frame routing, sendMessage/sendTyping().
 *
 * The socket is NOT proxied by nginx; it connects straight to the backend port.
 * Auth is the httpOnly session cookie, sent automatically on the handshake.
 *
 * Inbound frames (eleven shapes; see FRONTEND_SPEC.md §5):
 *   { type: "message", ... }                     -> "message"
 *   { type: "system", event, actor_*, target_* }  -> "system"
 *   { type: "ack", content, timestamp }          -> "ack"
 *   { type: "error", code, detail }               -> "error"
 *   { type: "chat_created", chat_id }             -> "chat_created"
 *   { type: "chat_deleted", chat_id }             -> "chat_deleted"
 *   { type: "chat_renamed", chat_id, new_name }   -> "chat_renamed"
 *   { type: "member_added", chat_id, user_id }    -> "member_added"
 *   { type: "member_removed", chat_id, user_id }  -> "member_removed"
 *   { type: "user_typing", chat_id, user_id }     -> "user_typing"
 *   { [chat_id]: [frames...] }                   -> "pending"  (no top-level type)
 * Plus a synthetic "status" event: "connecting" | "open" | "closed".
 *
 * Outbound, this client only ever publishes two things: a message, and a typing frame
 * (see sendTyping). Every other change -- membership, roles, renames, deletes -- is a
 * REST call; the server answers a client control frame it doesn't allow with an error.
 *
 * A "system" frame is a membership/role event (member_added / member_left / promoted /
 * demoted) recorded in the chat's timeline. It travels the chat's own pubsub channel like
 * a message and comes back from history in exactly the same shape, so app.js renders the
 * live copy and the historical one through one renderer.
 *
 * The two membership frames are sent ONLY to the user they are about -- the rest of the
 * chat is never told -- so "member_added" means *you* were added and "member_removed"
 * means *you* are out. app.js explains what that costs.
 *
 * A "user_typing" frame goes to every member of the chat EXCEPT the typist, and there is
 * no "stopped typing" frame to match it: the receiver expires the indicator on a timer
 * (app.js). A frame can arrive for a chat that isn't open.
 */
window.WS = (() => {
  "use strict";

  const WS_URL =
    (location.protocol === "https:" ? "wss://" : "ws://") + location.hostname + ":8000/ws";

  const MIN_BACKOFF = 2000;
  const MAX_BACKOFF = 30000;

  let socket = null;
  let backoff = MIN_BACKOFF;
  let timer = null;
  let stopped = false;
  const handlers = {};

  function on(event, fn) {
    (handlers[event] = handlers[event] || []).push(fn);
  }

  function emit(event, payload) {
    for (const fn of handlers[event] || []) {
      try { fn(payload); } catch (e) { console.error(`WS handler for "${event}" threw`, e); }
    }
  }

  function isOpen() {
    return !!socket && socket.readyState === WebSocket.OPEN;
  }

  function route(raw) {
    let data;
    try { data = JSON.parse(raw); } catch (_) { return; }
    if (!data || typeof data !== "object") return;
    switch (data.type) {
      case "message": emit("message", data); break;
      case "system":  emit("system", data); break;
      case "ack":     emit("ack", data); break;
      case "error":   emit("error", data); break;
      case "chat_created": emit("chat_created", data); break;
      case "chat_deleted": emit("chat_deleted", data); break;
      case "chat_renamed": emit("chat_renamed", data); break;
      case "member_added":   emit("member_added", data); break;
      case "member_removed": emit("member_removed", data); break;
      case "user_typing":    emit("user_typing", data); break;
      default:
        // Pending-messages map: keyed by chat_id, no top-level "type".
        if (data.type === undefined) emit("pending", data);
    }
  }

  function scheduleReconnect() {
    if (stopped || timer) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
    timer = setTimeout(async () => {
      timer = null;
      // The handshake is rejected if the access token expired, so make sure the
      // session is fresh first — API.getMe() runs the refresh interceptor and
      // redirects to /login/ if the refresh token is gone too.
      try {
        await window.API.getMe();
      } catch (e) {
        if (e && e.status === 401) return; // redirected to login
        // Server unreachable: still try to connect; failure re-schedules with a longer backoff.
      }
      connect();
    }, delay);
  }

  function connect() {
    if (stopped) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    if (timer) { clearTimeout(timer); timer = null; }

    emit("status", "connecting");
    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      emit("status", "closed");
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      backoff = MIN_BACKOFF;
      emit("status", "open");
    };
    ws.onmessage = (ev) => route(ev.data);
    ws.onerror = () => { /* the close event that follows carries the state change */ };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      emit("status", "closed");
      scheduleReconnect();
    };
  }

  // Close and reopen right away (e.g. after creating a chat, so the server
  // re-registers this socket for the new chat's channel).
  function reconnect() {
    backoff = MIN_BACKOFF;
    if (socket) {
      const s = socket;
      socket = null;
      s.onclose = null;
      try { s.close(); } catch (_) { /* ignore */ }
      emit("status", "closed");
    }
    if (timer) { clearTimeout(timer); timer = null; }
    // Give the server a beat to run the old socket's cleanup before we register again.
    timer = setTimeout(() => { timer = null; connect(); }, 300);
  }

  function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (socket) { try { socket.close(); } catch (_) { /* ignore */ } socket = null; }
  }

  function sendMessage(chatId, text) {
    if (!isOpen()) return false;
    socket.send(JSON.stringify({ type: "message", message: text, chat_id: chatId }));
    return true;
  }

  /* The only thing besides a message this client is allowed to publish. Note the shape:
   * `type` is "control" and `action` is what names it -- "typing" is the server's entire
   * allow-set, and anything else comes back as an error frame and is discarded. No
   * `user_id` is sent: the server always uses the session's and ignores a frame that
   * claims otherwise. Each frame is a Redis round-trip out to every other member, so the
   * caller throttles (app.js sends at most one every few seconds while typing).
   *
   * There is no "stopped typing" counterpart to send -- the receiving client expires its
   * own indicator -- so there is nothing to call when the user stops. */
  function sendTyping(chatId) {
    if (!isOpen() || !chatId) return false;
    socket.send(JSON.stringify({ type: "control", action: "typing", chat_id: chatId }));
    return true;
  }

  return { connect, reconnect, stop, on, isOpen, sendMessage, sendTyping, url: WS_URL };
})();
