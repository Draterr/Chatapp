/* api.js — REST helpers + single-flight access-token refresh.
 *
 * Every call goes through apiFetch(): "/api" prefix, credentials: "include".
 * A 401 means the access token is missing/invalid/expired; we POST /api/refresh
 * once (shared across concurrent callers), retry the request, and send the user
 * to /login/ if the refresh itself fails. A 403 is a permission answer ("not an
 * admin", "only admin") and is passed straight through -- refreshing can't fix it.
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
    if (res.status !== 401) return res;
    const ok = await refreshOnce();
    if (!ok) {
      toLogin();
      const err = new Error("Session expired");
      err.status = 401;
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
    /* Rename a group. Like change_role this is NOT a JSON body: chat_id is a path
     * segment and new_name a query parameter. Admin-only and group-only.
     * 200 {"message":"Chat renamed successfully"}; 403 "You can't rename a DM chat!" /
     * "You are not an admin of this chat!" / "You are not a member of this chat!";
     * 404 "Chat not found" only if the chat is really gone -- renaming to the name it
     * already has is a no-op 200. The server accepts any string including "", so callers
     * trim and reject an empty name themselves. The caller is told nothing by the
     * response beyond success: the new name arrives on the `chat_renamed` frame. */
    renameChat: (chatId, newName) =>
      apiFetch(
        "/chat/" + encodeURIComponent(chatId) + "/rename?new_name=" + encodeURIComponent(newName),
        { method: "POST" },
      ).then(toJson),

    /* POST /passwordchange — a JSON body with all three fields, which is the one account
     * edit the backend actually implements (POST /profile is commented out there).
     * `200 {"message":"Successfully Changed Password"}`;
     * `403 Password Missmatch` (new vs confirm — the server's own spelling);
     * `403 Password does not meet the requirement`;
     * `401 Unauthorized` with no session, which apiFetch turns into a refresh + retry.
     * `old_password` is required by the server's pydantic model (omit it and you get a 422)
     * but its value is NOT checked by the handler today, so this helper always sends it and
     * the UI always asks for it -- when the server starts verifying it, nothing here moves. */
    changePassword: (oldPassword, newPassword, confirmNewPassword) =>
      apiFetch("/passwordchange", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          old_password: oldPassword,
          new_password: newPassword,
          confirm_new_password: confirmNewPassword,
        }),
      }).then(toJson),

    changeRole: (chatId, userId, newRole) =>
      apiFetch(
        "/chat/change_role?chat_id=" + encodeURIComponent(chatId) +
        "&user_id=" + encodeURIComponent(userId) +
        "&new_role=" + encodeURIComponent(newRole),
        { method: "POST" },
      ).then(toJson),

    /* Remove someone from a group. `chat_id` is a PATH parameter and `user_id` a QUERY
     * parameter, with no body -- the same split change_role uses, and deliberate on the
     * backend, so don't "fix" it. Only an admin may kick, and only a plain member: an
     * admin has to be demoted first. 200 {"message":"User kicked from the chat
     * successfully"}; 403 "You are not a member of this chat!", 403 "You can't kick
     * someone from a DM chat!", 403 "You can't kick an admin from the chat!" (which is
     * also what a plain member gets for an admin target), 403 "You can't kick a user from
     * the chat!" (a plain member can't kick anybody); 404 "User not found in this chat"
     * when the target isn't a member. The kicked user gets a `member_removed` frame and
     * everyone still in the chat gets a `member_kicked` system frame -- but the caller
     * gets neither, so it must refresh /chats itself. */
    kickMember: (chatId, userId) =>
      apiFetch(
        `/chat/${encodeURIComponent(chatId)}/kick?user_id=${encodeURIComponent(userId)}`,
        { method: "POST" },
      ).then(toJson),

    logout: () => apiFetch("/logout", { method: "POST" }).then(toJson),
  };
})();
