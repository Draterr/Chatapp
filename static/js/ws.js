/* ws.js — WebSocket connection, reconnect, inbound frame routing, sendMessage().
 *
 * The socket is NOT proxied by nginx; it connects straight to the backend port.
 * Auth is the httpOnly session cookie, sent automatically on the handshake.
 *
 * Inbound frames (see FRONTEND_SPEC.md §5):
 *   { type: "message", ... }            -> "message"
 *   { type: "ack", content, timestamp } -> "ack"
 *   { type: "error", code, detail }     -> "error"
 *   { [chat_id]: [frames...] }          -> "pending"  (no top-level type)
 * Plus a synthetic "status" event: "connecting" | "open" | "closed".
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
      case "ack":     emit("ack", data); break;
      case "error":   emit("error", data); break;
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
        if (e && e.status === 403) return; // redirected to login
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

  return { connect, reconnect, stop, on, isOpen, sendMessage, url: WS_URL };
})();
