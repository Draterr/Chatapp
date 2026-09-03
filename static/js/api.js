/* api.js — REST helpers + single-flight access-token refresh.
 *
 * Every call goes through apiFetch(): "/api" prefix, credentials: "include".
 * A 403 means the access token is invalid/expired; we POST /api/refresh once
 * (shared across concurrent callers), retry the request, and send the user to
 * /login/ if the refresh itself fails.
 */
window.API = (() => {
  "use strict";

  const LOGIN_URL = "/login/";
  let refreshPromise = null;

  function toLogin() {
    if (location.pathname.startsWith(LOGIN_URL)) return;
    location.replace(LOGIN_URL);
  }

  // Only one refresh request is ever in flight; late callers await the same promise.
  function refreshOnce() {
    if (!refreshPromise) {
      refreshPromise = fetch("/api/refresh", { method: "POST", credentials: "include" })
        .then((r) => r.ok)
        .catch(() => false)
        .finally(() => { refreshPromise = null; });
    }
    return refreshPromise;
  }

  async function apiFetch(path, opts = {}) {
    const init = { ...opts, credentials: "include" };
    const res = await fetch("/api" + path, init);
    if (res.status !== 403) return res;
    const ok = await refreshOnce();
    if (!ok) {
      toLogin();
      const err = new Error("Session expired");
      err.status = 403;
      err.redirected = true;
      throw err;
    }
    return fetch("/api" + path, init);
  }

  // Parse JSON and turn non-2xx into an Error carrying .status and .detail.
  async function toJson(res) {
    let body = null;
    try { body = await res.json(); } catch (_) { /* empty / non-JSON body */ }
    if (!res.ok) {
      const detail = body && body.detail;
      const err = new Error(typeof detail === "string" ? detail : (res.statusText || "Request failed"));
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  const jsonHeaders = { "Content-Type": "application/json", Accept: "application/json" };

  return {
    apiFetch,
    toLogin,

    getMe: () => apiFetch("/me").then(toJson),

    getChats: () => apiFetch("/chats").then(toJson),

    getMessages: (chatId, { limit = 50, offset = 0 } = {}) =>
      apiFetch(`/chat/${encodeURIComponent(chatId)}/messages?limit=${limit}&offset=${offset}`).then(toJson),

    createChat: ({ chat_name, chat_users, is_dm }) =>
      apiFetch("/create_chat", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ chat_name, chat_users, is_dm }),
      }).then(toJson),

    logout: () => apiFetch("/logout", { method: "POST" }).then(toJson),
  };
})();
