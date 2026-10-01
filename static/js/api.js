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

    // Prefix match on display_name or username; the caller is excluded server-side
    // and `limit` is clamped to 1-25. `q` must be non-empty after trimming --
    // an empty query still hits the DB, so callers guard before calling.
    searchUsers: (q, { limit = 10, signal } = {}) =>
      apiFetch(`/users?q=${encodeURIComponent(q)}&limit=${limit}`, { signal }).then(toJson),

    getMessages: (chatId, { limit = 50, offset = 0 } = {}) =>
      apiFetch(`/chat/${encodeURIComponent(chatId)}/messages?limit=${limit}&offset=${offset}`).then(toJson),

    createChat: ({ chat_name, chat_users, is_dm }) =>
      apiFetch("/create_chat", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ chat_name, chat_users, is_dm }),
      }).then(toJson),

    /* Deletes a group for everyone, cascading its messages. The server refuses a DM
     * (403 "You can't delete a DM chat!") and a non-admin caller (403 "You are not an
     * admin of this chat!"); every member with a live socket then gets a `chat_deleted`
     * frame, the caller included. */
    deleteChat: (chatId) =>
      apiFetch("/chat/delete_chat", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ chat_id: chatId }),
      }).then(toJson),

    /* Add people to a group. `chat_id` is a PATH parameter and the body is a BARE JSON
     * ARRAY of user ids -- [16] or [16, 17], not wrapped in an object and with no key,
     * because the endpoint declares `user_id: list[int]` as the whole body. Added members
     * always land as role "user". Errors: 400 "User <id> is already a member of this
     * chat!" (with the id interpolated, and nothing is added -- the server checks every id
     * before inserting any), 403 "You can't add members to a DM!", 403 "You are not an
     * admin of this chat!", 403 "You are not a member of this chat!". Only the people who
     * were added get a `member_added` frame, so the caller must refresh /chats itself. */
    addMembers: (chatId, userIds) =>
      apiFetch(`/chat/${encodeURIComponent(chatId)}/add_member`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify(userIds),      // a bare array, deliberately not { user_id: [...] }
      }).then(toJson),

    /* Leave a group. `chat_id` is a PATH parameter and there is NO body and no query
     * string. 200 {"message":"Left the chat successfully"}; 403 "You can't leave a DM
     * chat!", 403 "There must be at least one admin in the chat!" when the sole admin
     * tries to leave (they have to promote someone first), and 403 "You are not a member
     * of this chat!" -- which is also what a second, duplicate leave returns. The leaver
     * gets a `member_removed` frame afterwards; nobody else is told. */
    leaveChat: (chatId) =>
      apiFetch(`/chat/${encodeURIComponent(chatId)}/leave`, { method: "POST" }).then(toJson),

    /* Promote/demote a group member. NOTE: this endpoint takes QUERY PARAMETERS, not a
     * JSON body — unlike every other POST here. That is deliberate on the backend for
     * now, so don't "fix" it into a body: FastAPI declares chat_id/user_id/new_role as
     * query params and a body would 422. `new_role` must be exactly "admin" or "user"
     * (a pydantic literal), and demoting the last admin is a 403. */
    changeRole: (chatId, userId, newRole) =>
      apiFetch(
        "/chat/change_role?chat_id=" + encodeURIComponent(chatId) +
        "&user_id=" + encodeURIComponent(userId) +
        "&new_role=" + encodeURIComponent(newRole),
        { method: "POST" },
      ).then(toJson),

    logout: () => apiFetch("/logout", { method: "POST" }).then(toJson),
  };
})();
