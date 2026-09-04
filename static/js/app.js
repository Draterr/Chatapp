/* app.js — state, rendering, event wiring, boot. Loaded after api.js and ws.js. */
(() => {
  "use strict";

  const PAGE_SIZE = 50;
  const GROUP_GAP_MS = 5 * 60 * 1000;       // new bubble group after 5 min of silence
  const COMPOSER_MAX_HEIGHT = 120;          // ~5 lines
  const DESKTOP = window.matchMedia("(min-width: 768px)");

  const state = {
    me: null,               // { user_id, user, display_name, avatar_url }
    chats: [],              // GET /api/chats `data`
    activeChatId: null,
    messagesByChat: {},     // { [chat_id]: [frames, oldest -> newest] }
    hasMoreByChat: {},      // { [chat_id]: bool }
    loadingHistory: {},     // { [chat_id]: true } while a page fetch is in flight
    liveBuffer: {},         // frames that arrived while history was loading
    sending: 0,             // messages sent, awaiting ack
    wsStatus: "closed",
    everOpened: false,      // has the socket opened at least once
    pendingCounted: false,  // first pending map is already reflected in unread counts
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    meAvatar: $("meAvatar"), meName: $("meName"), logoutBtn: $("logoutBtn"),
    newChatBtn: $("newChatBtn"), convList: $("convList"),
    backBtn: $("backBtn"), chatAvatar: $("chatAvatar"), chatTitle: $("chatTitle"),
    connBanner: $("connBanner"), messages: $("messages"), chatEmpty: $("chatEmpty"),
    composer: $("composer"), composerInput: $("composerInput"), sendBtn: $("sendBtn"),
    sendingHint: $("sendingHint"), toast: $("toast"),
    newChatDialog: $("newChatDialog"), newChatForm: $("newChatForm"), newChatError: $("newChatError"),
  };

  /* ---------- tiny DOM helper (never innerHTML with user content) ---------- */
  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "class") n.className = v;
        else if (k === "style") n.style.cssText = v;
        else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? "" : v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      n.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return n;
  }

  /* ---------- derived data (spec §6) ---------- */
  function hueFor(id) {
    let h = 0;
    for (const c of String(id)) h = c.charCodeAt(0) + ((h << 5) - h);
    return `hsl(${((h % 360) + 360) % 360} 45% 55%)`;
  }

  function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    const s = parts.length === 1 ? parts[0].slice(0, 1) : parts[0][0] + parts[parts.length - 1][0];
    return s.toUpperCase();
  }

  function isMine(msg) { return state.me && msg.sender_id === state.me.user_id; }
  function isGroup(chat) { return (chat.members || []).length > 2; }
  function findChat(chatId) { return state.chats.find((c) => c.chat_id === chatId); }

  function chatTitle(chat) {
    const members = chat.members || [];
    const others = members.filter((m) => m.user_id !== state.me.user_id);
    if (members.length === 2 && others.length === 1) return others[0].display_name || chat.chat_name;
    return chat.chat_name || others.map((m) => m.display_name).join(", ") || "Chat";
  }

  function memberName(chat, userId) {
    const m = (chat.members || []).find((x) => x.user_id === userId);
    return m ? m.display_name : "Someone";
  }

  function hasLastMessage(chat) {
    return !!(chat.last_message && chat.last_message.message_id);
  }

  /* ---------- time (spec §6.1): backend sends naive UTC ---------- */
  function parseUTC(s) {
    if (!s) return new Date(NaN);
    if (s instanceof Date) return s;
    return new Date(/(?:Z|[+-]\d\d:?\d\d)$/i.test(s) ? s : s + "Z");
  }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function daysAgo(d) { return Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000); }
  function sameDay(a, b) { return startOfDay(a).getTime() === startOfDay(b).getTime(); }

  function fmtTime(d) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function fmtCoarse(d) {           // sidebar
    if (isNaN(d)) return "";
    const n = daysAgo(d);
    if (n <= 0) return fmtTime(d);
    if (n === 1) return "Yesterday";
    if (n < 7) return d.toLocaleDateString([], { weekday: "short" });
    if (d.getFullYear() === new Date().getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
    return d.toLocaleDateString([], { month: "numeric", day: "numeric", year: "2-digit" });
  }
  function fmtDay(d) {              // day dividers
    if (isNaN(d)) return "";
    const n = daysAgo(d);
    if (n <= 0) return "Today";
    if (n === 1) return "Yesterday";
    if (n < 7) return d.toLocaleDateString([], { weekday: "long" });
    const opts = { month: "long", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString([], opts);
  }

  /* ---------- toast ---------- */
  let toastTimer = null;
  function toast(text, ms = 3500) {
    els.toast.textContent = text;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
  }

  /* ---------- message store ---------- */
  function sortChats() {
    const key = (c) => (hasLastMessage(c) ? parseUTC(c.last_message.time_sent).getTime() : 0);
    state.chats.sort((a, b) => key(b) - key(a));
  }

  // Merge frames into a loaded chat: dedupe by message_id, keep oldest -> newest.
  function mergeFrames(chatId, frames) {
    const list = state.messagesByChat[chatId];
    if (!list) return 0;
    const seen = new Set(list.map((m) => m.message_id));
    let added = 0;
    for (const f of frames) {
      if (!f || seen.has(f.message_id)) continue;
      seen.add(f.message_id);
      list.push(f);
      added++;
    }
    if (added) list.sort((a, b) => parseUTC(a.time_sent) - parseUTC(b.time_sent));
    return added;
  }

  // Route inbound frames into the store. Chats whose history hasn't been fetched
  // are left alone — the history fetch will include these messages.
  function storeIncoming(chatId, frames) {
    if (state.messagesByChat[chatId]) return mergeFrames(chatId, frames);
    if (state.loadingHistory[chatId]) {
      (state.liveBuffer[chatId] = state.liveBuffer[chatId] || []).push(...frames);
    }
    return 0;
  }

  function bumpLastMessage(chat, m) {
    if (hasLastMessage(chat) && parseUTC(chat.last_message.time_sent) > parseUTC(m.time_sent)) return;
    chat.last_message = {
      message_id: m.message_id, sender_id: m.sender_id, message: m.message, time_sent: m.time_sent,
    };
  }

  /* ---------- rendering: sidebar ---------- */
  function renderMe() {
    const name = state.me.display_name || state.me.user;
    els.meName.textContent = name;
    els.meAvatar.textContent = initials(name);
    els.meAvatar.style.background = hueFor("user:" + state.me.user_id);
  }

  function renderChatList() {
    const list = els.convList;
    list.replaceChildren();
    if (!state.chats.length) {
      list.append(el("div", { class: "list-empty" },
        el("p", null, "No conversations yet."),
        el("p", { class: "muted" }, "Chats you're added to will show up here.")));
      return;
    }
    for (const chat of state.chats) {
      const title = chatTitle(chat);
      let preview = "No messages yet";
      let time = "";
      if (hasLastMessage(chat)) {
        const lm = chat.last_message;
        const who = lm.sender_id === state.me.user_id ? "You: "
          : isGroup(chat) ? memberName(chat, lm.sender_id).split(/\s+/)[0] + ": " : "";
        preview = who + lm.message;
        time = fmtCoarse(parseUTC(lm.time_sent));
      }
      const unread = chat.unread_message_count > 0;
      list.append(el("button", {
        type: "button",
        class: "conv" + (chat.chat_id === state.activeChatId ? " active" : "") + (unread ? " unread" : ""),
        "data-chat": chat.chat_id,
      },
        el("span", { class: "avatar", style: `background:${hueFor(chat.chat_id)}`, "aria-hidden": "true" }, initials(title)),
        el("span", { class: "conv-main" },
          el("span", { class: "conv-name" }, title),
          el("span", { class: "conv-preview" }, preview)),
        el("span", { class: "conv-side" },
          el("span", { class: "conv-time" }, time),
          unread ? el("span", { class: "badge" }, String(chat.unread_message_count)) : null),
      ));
    }
  }

  /* ---------- rendering: chat pane ---------- */
  function renderHeader(chat) {
    if (!chat) {
      els.chatTitle.textContent = "";
      els.chatAvatar.hidden = true;
      return;
    }
    const title = chatTitle(chat);
    els.chatTitle.textContent = title;
    els.chatAvatar.hidden = false;
    els.chatAvatar.textContent = initials(title);
    els.chatAvatar.style.background = hueFor(chat.chat_id);
  }

  function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  // mode: "bottom" (jump to end) | "stick" (stay at end only if already there) | "prepend" (keep viewport)
  function renderMessages(chatId, mode = "bottom") {
    const box = els.messages;
    const msgs = state.messagesByChat[chatId];
    const chat = findChat(chatId);
    const group = chat ? isGroup(chat) : false;

    const prevHeight = box.scrollHeight;
    const prevTop = box.scrollTop;
    const wasAtBottom = prevHeight - prevTop - box.clientHeight < 80;

    box.replaceChildren();

    if (!msgs) {
      box.append(el("div", { class: "messages-note" }, "Loading…"));
      return;
    }
    if (state.hasMoreByChat[chatId] || state.loadingHistory[chatId]) {
      box.append(el("div", { class: "messages-note", id: "loadOlder" },
        state.loadingHistory[chatId] ? "Loading earlier messages…" : ""));
    }
    if (!msgs.length) {
      box.append(el("div", { class: "messages-empty" },
        el("p", null, "No messages yet."),
        el("p", { class: "muted" }, "Say hi 👋")));
    }

    let prev = null;
    let prevDate = null;
    msgs.forEach((m, i) => {
      const d = parseUTC(m.time_sent);
      const next = msgs[i + 1];
      const nextDate = next ? parseUTC(next.time_sent) : null;
      const newDay = !prev || !sameDay(prevDate, d);
      if (newDay) box.append(el("div", { class: "day" }, fmtDay(d)));

      const groupStart = newDay || prev.sender_id !== m.sender_id || d - prevDate > GROUP_GAP_MS;
      const groupEnd = !next || next.sender_id !== m.sender_id || !sameDay(d, nextDate) || nextDate - d > GROUP_GAP_MS;
      const mine = isMine(m);

      const col = el("div", { class: "msg-col" });
      if (groupStart && !mine && group) col.append(el("div", { class: "sender" }, m.sender_name));
      col.append(el("div", { class: "bubble", title: d.toLocaleString() }, m.message));
      if (groupEnd) col.append(el("div", { class: "meta" }, fmtTime(d)));

      box.append(el("div", {
        class: "msg" + (mine ? " mine" : " theirs") + (groupStart ? " group-start" : "") + (groupEnd ? " group-end" : ""),
      }, col));

      prev = m;
      prevDate = d;
    });

    if (mode === "prepend") {
      box.scrollTop = box.scrollHeight - prevHeight + prevTop;
    } else if (mode === "bottom" || wasAtBottom) {
      scrollToBottom();
    } else {
      box.scrollTop = prevTop;
    }

    // First page shorter than the viewport but more exists -> fetch another page.
    if (state.hasMoreByChat[chatId] && box.scrollHeight <= box.clientHeight) loadOlder(chatId);
  }

  function showChatPane(hasChat) {
    els.chatEmpty.hidden = hasChat;
    els.messages.hidden = !hasChat;
    els.composer.hidden = !hasChat;
  }

  function updateComposer() {
    const canSend = !!state.activeChatId && state.wsStatus === "open" && els.composerInput.value.trim().length > 0;
    els.sendBtn.disabled = !canSend;
    els.sendingHint.hidden = state.sending === 0;
  }

  function updateConnBanner() {
    const s = state.wsStatus;
    if (s === "open") { els.connBanner.hidden = true; return; }
    els.connBanner.textContent = s === "connecting"
      ? (state.everOpened ? "Reconnecting…" : "Connecting…")
      : "Offline — reconnecting shortly";
    els.connBanner.hidden = false;
  }

  /* ---------- actions ---------- */
  async function selectChat(chatId) {
    const chat = findChat(chatId);
    if (!chat) return;
    state.activeChatId = chatId;
    chat.unread_message_count = 0;
    document.body.dataset.view = "chat";
    renderChatList();
    renderHeader(chat);
    showChatPane(true);
    renderMessages(chatId, "bottom");
    updateComposer();
    if (DESKTOP.matches) els.composerInput.focus();

    if (!state.messagesByChat[chatId] && !state.loadingHistory[chatId]) {
      await loadHistory(chatId, 0);
      if (state.activeChatId === chatId) renderMessages(chatId, "bottom");
    }
  }

  async function loadHistory(chatId, offset) {
    state.loadingHistory[chatId] = true;
    try {
      const res = await API.getMessages(chatId, { limit: PAGE_SIZE, offset });
      const page = Array.isArray(res.data) ? res.data : [];
      if (!state.messagesByChat[chatId]) state.messagesByChat[chatId] = [];
      mergeFrames(chatId, page);
      state.hasMoreByChat[chatId] = !!res.has_more;
      const buffered = state.liveBuffer[chatId];
      if (buffered) { delete state.liveBuffer[chatId]; mergeFrames(chatId, buffered); }
      return true;
    } catch (e) {
      if (!e.redirected) toast(e.message || "Couldn't load messages");
      return false;
    } finally {
      delete state.loadingHistory[chatId];
    }
  }

  async function loadOlder(chatId) {
    if (!chatId || !state.hasMoreByChat[chatId] || state.loadingHistory[chatId]) return;
    const note = $("loadOlder");
    if (note) note.textContent = "Loading earlier messages…";
    const before = state.messagesByChat[chatId].length;
    await loadHistory(chatId, before);
    if (state.activeChatId === chatId) renderMessages(chatId, "prepend");
  }

  async function refreshChats() {
    try {
      const res = await API.getChats();
      const fresh = Array.isArray(res.data) ? res.data : [];
      // Keep client-side unread counts for chats we already know about.
      const oldById = new Map(state.chats.map((c) => [c.chat_id, c]));
      for (const c of fresh) {
        const old = oldById.get(c.chat_id);
        if (old && state.everOpened) c.unread_message_count = old.unread_message_count;
        if (c.chat_id === state.activeChatId) c.unread_message_count = 0;
      }
      state.chats = fresh;
      sortChats();
      renderChatList();
      if (state.activeChatId && !findChat(state.activeChatId)) {
        state.activeChatId = null;
        renderHeader(null);
        showChatPane(false);
      }
    } catch (e) {
      if (!e.redirected) toast(e.message || "Couldn't load chats");
    }
  }

  let sendingTimer = null;
  function sendCurrent() {
    const text = els.composerInput.value.trim();
    if (!text || !state.activeChatId) return;
    if (!WS.sendMessage(state.activeChatId, text)) {
      toast("Not connected — try again in a moment");
      return;
    }
    els.composerInput.value = "";
    autoGrow();
    state.sending++;
    updateComposer();
    // Safety net: never leave the hint stuck if an ack is lost.
    clearTimeout(sendingTimer);
    sendingTimer = setTimeout(() => { state.sending = 0; updateComposer(); }, 8000);
  }

  function autoGrow() {
    const ta = els.composerInput;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, COMPOSER_MAX_HEIGHT) + "px";
  }

  async function logout() {
    els.logoutBtn.disabled = true;
    WS.stop();
    try { await API.logout(); } catch (_) { /* already logged out */ }
    location.replace("/login/");
  }

  /* ---------- WebSocket events ---------- */
  function wireSocket() {
    WS.on("status", (s) => {
      state.wsStatus = s;
      if (s === "open") {
        if (state.everOpened) {
          // Reconnect: the list may be stale (chats created/renamed while offline).
          state.pendingCounted = true;
          refreshChats();
        }
        state.everOpened = true;
      }
      updateConnBanner();
      updateComposer();
    });

    WS.on("message", (m) => {
      const chat = findChat(m.chat_id);
      if (!chat) { refreshChats(); return; }
      storeIncoming(m.chat_id, [m]);
      bumpLastMessage(chat, m);
      const mine = isMine(m);
      if (!mine && m.chat_id !== state.activeChatId) chat.unread_message_count = (chat.unread_message_count || 0) + 1;
      sortChats();
      renderChatList();
      if (m.chat_id === state.activeChatId) renderMessages(m.chat_id, mine ? "bottom" : "stick");
    });

    WS.on("chat_created", (f) => {
      // Server added us to a new chat; pull the sidebar entry if we don't have it yet.
      if (!findChat(f.chat_id)) refreshChats();
    });

    WS.on("pending", (map) => {
      // First map after boot replays exactly the rows GET /api/chats already counted as unread;
      // later maps (after a reconnect) are new.
      const countNew = state.pendingCounted;
      state.pendingCounted = true;
      let unknownChat = false;
      for (const [chatId, frames] of Object.entries(map)) {
        if (!Array.isArray(frames) || !frames.length) continue;
        const chat = findChat(chatId);
        if (!chat) { unknownChat = true; continue; }
        storeIncoming(chatId, frames);
        for (const f of frames) bumpLastMessage(chat, f);
        if (countNew && chatId !== state.activeChatId) {
          chat.unread_message_count = (chat.unread_message_count || 0) + frames.filter((f) => !isMine(f)).length;
        }
        if (chatId === state.activeChatId) renderMessages(chatId, "stick");
      }
      sortChats();
      renderChatList();
      if (unknownChat) refreshChats();
    });

    WS.on("ack", () => {
      if (state.sending > 0) state.sending--;
      updateComposer();
    });

    WS.on("error", (e) => {
      if (state.sending > 0) state.sending--;
      updateComposer();
      toast(e.detail || e.code || "Message failed");
    });
  }

  /* ---------- new chat (dev affordance — no user directory endpoint yet) ---------- */
  function openNewChat() {
    els.newChatError.textContent = "";
    els.newChatForm.reset();
    els.newChatDialog.showModal();
  }

  async function submitNewChat(ev) {
    ev.preventDefault();
    const fd = new FormData(els.newChatForm);
    const name = String(fd.get("chat_name") || "").trim();
    const ids = String(fd.get("chat_users") || "")
      .split(/[\s,]+/).filter(Boolean).map(Number);
    const isDm = fd.get("is_dm") === "on";
    if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
      els.newChatError.textContent = "User ids must be positive whole numbers.";
      return;
    }
    if (!ids.length) { els.newChatError.textContent = "Add at least one user id."; return; }
    if (isDm && ids.length !== 1) { els.newChatError.textContent = "A direct message has exactly one other member."; return; }
    if (!isDm && !name) { els.newChatError.textContent = "Group chats need a name."; return; }
    const btn = els.newChatForm.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await API.createChat({ chat_name: name || "Direct message", chat_users: ids, is_dm: isDm });
      els.newChatDialog.close();
      await refreshChats();    // server registers the new chat on the live socket via a control frame
      if (state.chats.length) selectChat(state.chats[0].chat_id);
    } catch (e) {
      els.newChatError.textContent = e.message || "Couldn't create chat";
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- event wiring ---------- */
  function wireUI() {
    els.convList.addEventListener("click", (ev) => {
      const row = ev.target.closest("[data-chat]");
      if (row) selectChat(row.dataset.chat);
    });
    els.backBtn.addEventListener("click", () => { document.body.dataset.view = "list"; });
    els.logoutBtn.addEventListener("click", logout);
    els.newChatBtn.addEventListener("click", openNewChat);
    els.newChatForm.addEventListener("submit", submitNewChat);
    els.newChatDialog.querySelector("[data-close]").addEventListener("click", () => els.newChatDialog.close());

    els.composerInput.addEventListener("input", () => { autoGrow(); updateComposer(); });
    els.composerInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        sendCurrent();
      }
    });
    els.sendBtn.addEventListener("click", sendCurrent);

    els.messages.addEventListener("scroll", () => {
      if (els.messages.scrollTop < 80) loadOlder(state.activeChatId);
    });

    window.addEventListener("online", () => WS.connect());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") WS.connect();
    });
  }

  /* ---------- boot ---------- */
  async function boot() {
    document.body.dataset.view = "list";
    try {
      state.me = await API.getMe();
    } catch (e) {
      if (e.status === 403) { API.toLogin(); return; }
      toast("Can't reach the server. Retrying…");
      setTimeout(boot, 3000);
      return;
    }
    renderMe();
    wireUI();
    wireSocket();

    try {
      const res = await API.getChats();
      state.chats = Array.isArray(res.data) ? res.data : [];
      sortChats();
    } catch (e) {
      if (e.redirected) return;
      toast(e.message || "Couldn't load chats");
    }
    renderChatList();
    showChatPane(false);
    updateConnBanner();
    WS.connect();

    if (state.chats.length && DESKTOP.matches) selectChat(state.chats[0].chat_id);
  }

  boot();
})();
