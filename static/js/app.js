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
    awaitingNewChat: null,  // Set of chat_ids from just before POST /create_chat
  };

  // People picker (the "New conversation" dialog).
  const picker = {
    selected: [],   // [{ user_id, display_name, username, avatar_url }]
    results: [],    // last search response, minus nothing -- already-chosen rows stay, marked
    active: -1,     // keyboard cursor into results
    timer: null,    // debounce
    abort: null,    // AbortController for the in-flight search
    busy: false,    // create request in flight
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
    pickerField: $("pickerField"), pickerInput: $("pickerInput"),
    pickerChips: $("pickerChips"), pickerResults: $("pickerResults"),
    pickerStatus: $("pickerStatus"), groupNameRow: $("groupNameRow"), groupNameInput: $("groupNameInput"),
    newChatSubmit: $("newChatSubmit"),
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

  // One avatar everywhere: a hued circle with initials, overlaid by the image when
  // `avatar_url` is set. A broken image removes itself, uncovering the initials.
  function avatarEl(name, seed, url, extraClass) {
    const node = el("span", {
      class: "avatar" + (extraClass ? " " + extraClass : ""),
      style: `--avatar-hue:${hueFor(seed)}`,
      "aria-hidden": "true",
    }, initials(name));
    if (url) {
      const img = el("img", { src: url, alt: "" });
      img.addEventListener("error", () => img.remove());
      node.append(img);
    }
    return node;
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

  // DMs are hued by the other person so they look the same here, in the header and
  // in the picker; groups are hued by chat_id (spec §6).
  function otherMember(chat) {
    const members = chat.members || [];
    if (members.length !== 2) return null;
    return members.find((m) => m.user_id !== state.me.user_id) || null;
  }
  function chatAvatarSeed(chat) {
    const other = otherMember(chat);
    return other ? "user:" + other.user_id : chat.chat_id;
  }

  function memberName(chat, userId) {
    const m = (chat.members || []).find((x) => x.user_id === userId);
    return m ? m.display_name : "Someone";
  }

  function hasLastMessage(chat) {
    return !!(chat.last_message && chat.last_message.message_id);
  }

  /* ---------- time ----------
   * Every timestamp the backend sends is RFC 3339 with an explicit offset and
   * microsecond precision ("2026-09-03T12:28:31.590965+00:00"). Older rows, and
   * anything that slips through without an offset, are naive UTC. parseTime() is
   * the single entry point: it normalises the fractional seconds to the three
   * digits `Date` is specified to accept, adds a colon to a compact "+0000"
   * offset, and defaults a missing offset to UTC. Garbage yields an Invalid Date
   * (every formatter below guards isNaN) rather than throwing.
   */
  const ISO_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

  function parseTime(v) {
    if (v instanceof Date) return v;
    if (typeof v !== "string") return new Date(NaN);
    const s = v.trim();
    if (!s) return new Date(NaN);
    const m = ISO_RE.exec(s);
    if (!m) return new Date(s);                       // let the engine try; NaN if it can't
    const [, date, clock, frac, rawZone] = m;
    const ms = frac ? "." + (frac + "000").slice(0, 3) : "";
    let zone = rawZone || "Z";                        // no offset -> naive UTC
    if (/^[+-]\d{4}$/.test(zone)) zone = zone.slice(0, 3) + ":" + zone.slice(3);
    return new Date(date + "T" + clock + ms + zone);
  }

  // Full local date + time + zone abbreviation, for `title` tooltips.
  let stampFmt = null;
  function fullStamp(d) {
    if (isNaN(d)) return "";
    if (!stampFmt) {
      const opts = {
        weekday: "short", year: "numeric", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", timeZoneName: "short",
      };
      try { stampFmt = new Intl.DateTimeFormat([], opts); }
      catch (_) { stampFmt = { format: (x) => x.toLocaleString() }; }
    }
    return stampFmt.format(d);
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
    const key = (c) => (hasLastMessage(c) ? parseTime(c.last_message.time_sent).getTime() : 0);
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
    if (added) list.sort((a, b) => parseTime(a.time_sent) - parseTime(b.time_sent));
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
    if (hasLastMessage(chat) && parseTime(chat.last_message.time_sent) > parseTime(m.time_sent)) return;
    chat.last_message = {
      message_id: m.message_id, sender_id: m.sender_id, message: m.message, time_sent: m.time_sent,
    };
  }

  /* ---------- rendering: sidebar ---------- */
  function renderMe() {
    const name = state.me.display_name || state.me.user;
    els.meName.textContent = name;
    els.meAvatar.replaceWith(
      Object.assign(avatarEl(name, "user:" + state.me.user_id, state.me.avatar_url, "avatar-sm"),
        { id: "meAvatar" }));
    els.meAvatar = $("meAvatar");
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
      let timeTitle = "";
      if (hasLastMessage(chat)) {
        const lm = chat.last_message;
        const who = lm.sender_id === state.me.user_id ? "You: "
          : isGroup(chat) ? memberName(chat, lm.sender_id).split(/\s+/)[0] + ": " : "";
        preview = who + lm.message;
        const d = parseTime(lm.time_sent);
        time = fmtCoarse(d);
        timeTitle = fullStamp(d);
      }
      const unread = chat.unread_message_count > 0;
      list.append(el("button", {
        type: "button",
        class: "conv" + (chat.chat_id === state.activeChatId ? " active" : "") + (unread ? " unread" : ""),
        "data-chat": chat.chat_id,
      },
        avatarEl(title, chatAvatarSeed(chat), (otherMember(chat) || {}).avatar_url),
        el("span", { class: "conv-main" },
          el("span", { class: "conv-name" }, title),
          el("span", { class: "conv-preview" }, preview)),
        el("span", { class: "conv-side" },
          el("span", { class: "conv-time", title: timeTitle || null }, time),
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
    const next = avatarEl(title, chatAvatarSeed(chat), (otherMember(chat) || {}).avatar_url, "avatar-sm");
    next.id = "chatAvatar";
    els.chatAvatar.replaceWith(next);
    els.chatAvatar = next;
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
      const d = parseTime(m.time_sent);
      const next = msgs[i + 1];
      const nextDate = next ? parseTime(next.time_sent) : null;
      const newDay = !prev || !sameDay(prevDate, d);
      if (newDay) box.append(el("div", { class: "day" }, fmtDay(d)));

      const groupStart = newDay || prev.sender_id !== m.sender_id || d - prevDate > GROUP_GAP_MS;
      const groupEnd = !next || next.sender_id !== m.sender_id || !sameDay(d, nextDate) || nextDate - d > GROUP_GAP_MS;
      const mine = isMine(m);

      const col = el("div", { class: "msg-col" });
      if (groupStart && !mine && group) col.append(el("div", { class: "sender" }, m.sender_name));
      col.append(el("div", { class: "bubble" }, m.message));
      if (groupEnd) col.append(el("div", { class: "meta", title: fullStamp(d) }, fmtTime(d)));

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
      // The chat we just asked for? Refresh and open it (adoptNewChat is idempotent).
      if (state.awaitingNewChat && !state.awaitingNewChat.has(f.chat_id)) { adoptNewChat(); return; }
      // Otherwise someone else added us: pull the sidebar entry if we don't have it.
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

  /* ---------- new conversation: people picker ----------
   * GET /api/users?q= is a prefix search; the caller is excluded server-side.
   * One person selected is a DM, two or more is a named group.
   */
  const SEARCH_DEBOUNCE = 150;
  const SEARCH_LIMIT = 10;

  function cancelSearch() {
    clearTimeout(picker.timer);
    picker.timer = null;
    if (picker.abort) { picker.abort.abort(); picker.abort = null; }
  }

  function openNewChat() {
    cancelSearch();
    picker.selected = [];
    picker.results = [];
    picker.active = -1;
    picker.busy = false;
    els.pickerInput.value = "";
    els.groupNameInput.value = "";
    els.newChatError.textContent = "";
    els.pickerStatus.textContent = "";
    renderPicker();
    els.newChatDialog.showModal();
    els.pickerInput.focus();
  }

  function closePicker() {
    cancelSearch();
    if (els.newChatDialog.open) els.newChatDialog.close();
  }

  function renderPicker() {
    renderChips();
    renderResults();
    renderPickerMode();
  }

  function renderPickerMode() {
    const n = picker.selected.length;
    els.groupNameRow.hidden = n < 2;                       // a DM's title comes from its members
    els.newChatSubmit.textContent = n >= 2 ? "Create group" : "Message";
    els.newChatSubmit.disabled = n === 0 || picker.busy;
    els.newChatDialog.classList.toggle("has-chips", n > 0);
  }

  function renderChips() {
    els.pickerChips.replaceChildren();
    for (const u of picker.selected) {
      const name = u.display_name || u.username;
      els.pickerChips.append(el("span", { class: "chip" },
        avatarEl(name, "user:" + u.user_id, u.avatar_url, "avatar-xs"),
        el("span", { class: "chip-name" }, name),
        el("button", {
          type: "button", class: "chip-x", "aria-label": "Remove " + name,
          onclick: () => pickerRemove(u.user_id),
        }, "\u00d7")));
    }
  }

  function renderResults() {
    const list = els.pickerResults;
    list.replaceChildren();
    const chosen = new Set(picker.selected.map((u) => u.user_id));
    picker.results.forEach((u, i) => {
      const name = u.display_name || u.username;
      const already = chosen.has(u.user_id);
      list.append(el("li", {
        class: "picker-row" + (i === picker.active ? " active" : "") + (already ? " chosen" : ""),
        role: "option",
        "aria-selected": i === picker.active ? "true" : "false",
        id: "picker-opt-" + i,
        "data-user": String(u.user_id),
      },
        avatarEl(name, "user:" + u.user_id, u.avatar_url, "avatar-sm"),
        el("span", { class: "picker-row-main" },
          el("span", { class: "picker-row-name" }, name),
          el("span", { class: "picker-row-handle" }, "@" + u.username)),
        already ? el("span", { class: "picker-row-tag" }, "Added") : null));
    });
    els.pickerInput.setAttribute("aria-expanded", picker.results.length ? "true" : "false");
    if (picker.active >= 0) els.pickerInput.setAttribute("aria-activedescendant", "picker-opt-" + picker.active);
    else els.pickerInput.removeAttribute("aria-activedescendant");
    const active = list.querySelector(".picker-row.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function onPickerInput() {
    cancelSearch();
    const q = els.pickerInput.value.trim();
    if (!q) {                                   // an empty q would still hit the DB
      picker.results = [];
      picker.active = -1;
      els.pickerStatus.textContent = "";
      renderResults();
      return;
    }
    picker.timer = setTimeout(() => runSearch(q), SEARCH_DEBOUNCE);
  }

  async function runSearch(q) {
    const ctrl = new AbortController();
    picker.abort = ctrl;
    picker.timer = null;
    els.newChatError.textContent = "";
    try {
      const res = await API.searchUsers(q, { limit: SEARCH_LIMIT, signal: ctrl.signal });
      // Drop the answer if a newer keystroke superseded it, or the field moved on.
      if (picker.abort !== ctrl || els.pickerInput.value.trim() !== q) return;
      picker.abort = null;
      picker.results = Array.isArray(res.users) ? res.users : [];
      picker.active = picker.results.length ? 0 : -1;
      els.pickerStatus.textContent = picker.results.length ? "" : `No one matches “${q}”`;
      renderResults();
    } catch (e) {
      if (ctrl.signal.aborted || (e && e.name === "AbortError")) return;
      if (picker.abort === ctrl) picker.abort = null;
      if (e && e.redirected) return;
      picker.results = [];
      picker.active = -1;
      els.pickerStatus.textContent = "";
      renderResults();
      els.newChatError.textContent = "Couldn't search for people — check your connection.";
    }
  }

  function movePicker(delta) {
    if (!picker.results.length) return;
    const n = picker.results.length;
    picker.active = picker.active < 0
      ? (delta > 0 ? 0 : n - 1)
      : (picker.active + delta + n) % n;
    renderResults();
  }

  function pickerAdd(u) {
    if (!u || picker.selected.some((s) => s.user_id === u.user_id)) return;   // no-op
    picker.selected.push(u);
    cancelSearch();
    picker.results = [];
    picker.active = -1;
    els.pickerInput.value = "";
    els.pickerStatus.textContent = "";
    els.newChatError.textContent = "";
    renderPicker();
    els.pickerInput.focus();
  }

  function pickerRemove(userId) {
    picker.selected = picker.selected.filter((u) => u.user_id !== userId);
    renderPicker();
    els.pickerInput.focus();
  }

  /* POST /create_chat returns { "Success": ... } and no chat_id, so the new chat is
   * whichever id shows up that wasn't there before the call. Two things can reveal
   * it -- our own refresh, and the server's chat_created control frame -- so both
   * funnel through here and the first one to find it wins. */
  let adopting = null;
  function adoptNewChat() {
    if (!state.awaitingNewChat) return Promise.resolve(false);
    if (adopting) return adopting;
    const before = state.awaitingNewChat;
    adopting = (async () => {
      await refreshChats();
      if (state.awaitingNewChat !== before) return false;
      const fresh = state.chats.find((c) => !before.has(c.chat_id));
      if (!fresh) return false;
      state.awaitingNewChat = null;
      await selectChat(fresh.chat_id);
      els.composerInput.focus();
      return true;
    })().finally(() => { adopting = null; });
    return adopting;
  }

  async function submitNewChat(ev) {
    ev.preventDefault();
    if (picker.busy || !picker.selected.length) return;
    els.newChatError.textContent = "";
    const chosen = picker.selected.slice();
    const isDm = chosen.length === 1;

    // The backend has no DM-uniqueness check, so a second DM with the same person
    // would silently create a second chat. Open the one we already have instead.
    if (isDm) {
      const existing = state.chats.find(
        (c) => (c.members || []).length === 2 && c.members.some((m) => m.user_id === chosen[0].user_id));
      if (existing) {
        closePicker();
        await selectChat(existing.chat_id);
        els.composerInput.focus();
        return;
      }
    }

    // chat_name is required by the API; a DM's UI title comes from its members anyway.
    const name = isDm ? (chosen[0].display_name || chosen[0].username) : els.groupNameInput.value.trim();
    if (!isDm && !name) {
      els.newChatError.textContent = "Give the group a name.";
      els.groupNameInput.focus();
      return;
    }

    picker.busy = true;
    renderPickerMode();
    state.awaitingNewChat = new Set(state.chats.map((c) => c.chat_id));
    const claimed = state.awaitingNewChat;
    // Don't let a stale flag hijack an unrelated chat_created frame later on.
    setTimeout(() => { if (state.awaitingNewChat === claimed) state.awaitingNewChat = null; }, 15000);
    try {
      await API.createChat({ chat_name: name, chat_users: chosen.map((u) => u.user_id), is_dm: isDm });
      closePicker();
      await adoptNewChat();
    } catch (e) {
      if (state.awaitingNewChat === claimed) state.awaitingNewChat = null;
      if (!(e && e.redirected)) els.newChatError.textContent = e.message || "Couldn't start the conversation.";
    } finally {
      picker.busy = false;
      renderPickerMode();
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
    for (const b of els.newChatDialog.querySelectorAll("[data-close]")) {
      b.addEventListener("click", closePicker);
    }
    // Esc closes the dialog natively; make sure the in-flight search dies with it.
    els.newChatDialog.addEventListener("close", cancelSearch);

    els.pickerInput.addEventListener("input", onPickerInput);
    els.pickerInput.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown") { ev.preventDefault(); movePicker(1); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); movePicker(-1); }
      else if (ev.key === "Enter" && !ev.isComposing) {
        // Never let Enter reach the form -- in the picker it means "pick this one".
        ev.preventDefault();
        pickerAdd(picker.results[picker.active]);
      } else if (ev.key === "Backspace" && !els.pickerInput.value && picker.selected.length) {
        ev.preventDefault();
        pickerRemove(picker.selected[picker.selected.length - 1].user_id);
      }
    });
    els.pickerResults.addEventListener("click", (ev) => {
      const row = ev.target.closest("[data-user]");
      if (row) pickerAdd(picker.results.find((u) => String(u.user_id) === row.dataset.user));
    });
    els.pickerResults.addEventListener("mousemove", (ev) => {
      const row = ev.target.closest("[data-user]");
      if (!row) return;
      const i = picker.results.findIndex((u) => String(u.user_id) === row.dataset.user);
      if (i >= 0 && i !== picker.active) { picker.active = i; renderResults(); }
    });
    els.pickerField.addEventListener("click", (ev) => {
      if (!ev.target.closest(".chip-x")) els.pickerInput.focus();
    });

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
