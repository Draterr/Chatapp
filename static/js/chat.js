/* ============================================================
   Chat page logic — ported from Chat.dc.html (Claude Design).
   Vanilla JS, no framework. Drives the UI from a mock DATA
   layer so the page runs with no backend. The wiring needed to
   make it real is marked in "BACKEND INTEGRATION POINTS" below
   and tracked in /BACKEND_TODO.md.
   ============================================================ */
"use strict";

/* ---------- Theme tokens (for settings swatches + labels) ---------- */
const THEMES = {
  black: { name: "Charcoal Black", note: "Neutral near-black, like Instagram", sw: ["#0e0f11", "#1f2123", "#5b7595"] },
  nord:  { name: "Nord Slate",     note: "Cool blue-grey, easy at night",      sw: ["#2e3440", "#5e81ac", "#81a1c1"] },
  earth: { name: "Earth Light",    note: "Warm clay & beige, soft daylight",   sw: ["#f3efe9", "#b08968", "#a3957f"] },
};
const THEME_ORDER = ["black", "nord", "earth"];

/* ---------- Settings definitions (ported from design) ---------- */
const SETTINGS = {
  account: { title: "Account", desc: "Manage your profile and account details.", rows: [
    { k: "a1", label: "Two-factor authentication", desc: "Add an extra layer of security", on: true },
    { k: "a2", label: "Show active status", desc: "Let people see when you are online", on: true },
    { k: "a3", label: "Read receipts", desc: "Share when you have read messages", on: true } ] },
  notifications: { title: "Notifications", desc: "Control how and when you are notified.", rows: [
    { k: "n1", label: "Message notifications", desc: "Banner and sound for new messages", on: true },
    { k: "n2", label: "Group notifications", desc: "Notify for activity in groups", on: false },
    { k: "n3", label: "Reaction notifications", desc: "Notify when someone reacts", on: false },
    { k: "n4", label: "In-app sounds", desc: "Play subtle sounds inside the app", on: true } ] },
  privacy: { title: "Privacy", desc: "Decide who can reach and see you.", rows: [
    { k: "p1", label: "Last seen", desc: "Show when you were last active", on: false },
    { k: "p2", label: "Profile photo", desc: "Visible to everyone", on: true },
    { k: "p3", label: "Block unknown senders", desc: "Filter messages from non-contacts", on: true } ] },
  appearance: { title: "Appearance", desc: "Customise the look and feel of your chats.", rows: [
    { k: "ap1", label: "Chat wallpaper", desc: "Show the subtle dotted backdrop", on: true },
    { k: "ap2", label: "Compact density", desc: "Tighter spacing in the chat list", on: false } ] },
  chats: { title: "Chats", desc: "Defaults for your conversations.", rows: [
    { k: "c1", label: "Enter to send", desc: "Press Enter to send, Shift+Enter for a new line", on: true },
    { k: "c2", label: "Media auto-download", desc: "Save incoming photos automatically", on: false },
    { k: "c3", label: "Archive muted chats", desc: "Keep muted threads out of the list", on: true } ] },
};
const TAB_ORDER = ["account", "notifications", "privacy", "appearance", "chats"];
const TAB_ICONS = {
  account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  notifications: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
  privacy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  appearance: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18 4.5 4.5 0 0 1 0-9 4.5 4.5 0 0 0 0-9z"/></svg>',
  chats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-9 8.5 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5z"/></svg>',
};

/* ============================================================
   MOCK DATA — replace with the real backend (see BACKEND_TODO.md)
   ============================================================ */
const DATA = {
  // self identity — comes from GET /api/me eventually
  me: { user_id: 0, name: "Alex Mercer", username: "alex.mercer", initials: "AM",
        bio: "Designing quietly. Available for the things that matter." },
  convs: [
    { id: "jordan", name: "Jordan", initials: "JO", color: "#6b7f99", online: true, last: "OKokkk", time: "5:37 PM", unread: 0, username: "jordan.r", presence: "Online" },
    { id: "maya", name: "Maya Chen", initials: "MC", color: "#9a7b8e", online: true, last: "see you tomorrow then", time: "4:12 PM", unread: 2, username: "maya.chen", presence: "Online" },
    { id: "design", name: "Design Team", initials: "DT", color: "#7e8a6b", online: false, group: true, last: "Priya: shipped the new icons", time: "2:30 PM", unread: 5, username: "6 members", presence: "6 members" },
    { id: "sam", name: "Sam Rivera", initials: "SR", color: "#8a7f6f", online: false, last: "You: sounds good to me", time: "Yesterday", unread: 0, username: "sam.rivera", presence: "last seen yesterday" },
    { id: "priya", name: "Priya Nair", initials: "PN", color: "#6f8a85", online: true, last: "thank you so much", time: "Yesterday", unread: 0, username: "priya.n", presence: "Online" },
    { id: "marcus", name: "Marcus Bell", initials: "MB", color: "#99846b", online: false, last: "haha true", time: "Mon", unread: 0, username: "marcus.b", presence: "last seen Monday" },
    { id: "book", name: "Book Club", initials: "BC", color: "#7b6f99", group: true, online: false, last: "Elena: whats our next pick?", time: "Sun", unread: 0, username: "4 members", presence: "4 members" },
  ],
  messagesByConv: {
    jordan: [
      { id: 1, text: "Hey, did you get a chance to look at the deck?", time: "5:33 PM" },
      { id: 2, text: "Ummm", time: "5:35 PM" },
      { id: 3, text: "I think manual is the way to go", time: "5:35 PM" },
      { id: 4, mine: true, text: "yea i agree, generating it every time costs way too much", time: "5:36 PM" },
      { id: 5, text: "Yeah no worries", time: "5:36 PM" },
      { id: 6, text: "I can do it manually", time: "5:36 PM" },
      { id: 7, mine: true, text: "here is the link for the previous layout", time: "5:36 PM" },
      { id: 8, text: "Did you have to make it again?", time: "5:36 PM" },
      { id: 9, mine: true, text: "nah its just the old one", time: "5:37 PM" },
      { id: 10, text: "Thanks man, I will be using this", time: "5:37 PM" },
      { id: 11, text: "OKokkk", time: "5:37 PM" },
    ],
    maya: [
      { id: 1, text: "are we still on for tomorrow?", time: "4:05 PM" },
      { id: 2, mine: true, text: "yep, 10am works for me", time: "4:10 PM" },
      { id: 3, text: "perfect", time: "4:11 PM" },
      { id: 4, text: "see you tomorrow then", time: "4:12 PM" },
    ],
    design: [
      { id: 1, text: "Pushed the spacing fixes to staging", time: "1:40 PM" },
      { id: 2, mine: true, text: "nice, will review after lunch", time: "2:02 PM" },
      { id: 3, text: "shipped the new icons", time: "2:30 PM" },
    ],
    sam: [
      { id: 1, text: "can you send the invoice when you get a sec", time: "Yesterday" },
      { id: 2, mine: true, text: "sounds good to me", time: "Yesterday" },
    ],
    priya: [
      { id: 1, mine: true, text: "sent over the files just now", time: "Yesterday" },
      { id: 2, text: "thank you so much", time: "Yesterday" },
    ],
    marcus: [
      { id: 1, text: "did you see the game last night", time: "Mon" },
      { id: 2, mine: true, text: "haha true", time: "Mon" },
    ],
    book: [
      { id: 1, text: "finished the last chapter finally", time: "Sun" },
      { id: 2, text: "whats our next pick?", time: "Sun" },
    ],
  },
};

/* ---------- App state ---------- */
const state = {
  activeId: "jordan",
  modal: null,          // 'self' | 'other' | 'settings' | null
  menuOpen: false,
  searchOpen: false,
  isNarrow: false,
  view: "list",         // mobile pane: 'list' | 'chat'
  theme: "nord",
  settingsTab: "appearance",
  confirm: null,        // { type, title, body, cta }
  toggles: {},          // per-key overrides for settings switches
  convs: DATA.convs,
  messagesByConv: DATA.messagesByConv,
};

/* ---------- DOM refs ---------- */
const $ = (sel) => document.querySelector(sel);
const els = {
  convList: $("#convList"),
  messages: $("#messages"),
  headAvatar: $("#headAvatar"),
  headName: $("#headName"),
  headPresence: $("#headPresence"),
  headMenu: $("#headMenu"),
  chatSearch: $("#chatSearch"),
  wallpaper: $("#wallpaper"),
  composer: $("#composerInput"),
  modalRoot: $("#modalRoot"),
  railAvatar: $("#railAvatar"),
};

/* ---------- Helpers ---------- */
const esc = (s) => s.replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const activeConv = () => state.convs.find((c) => c.id === state.activeId) || state.convs[0];
const toggleOn = (k, def) => (k in state.toggles ? state.toggles[k] : def);
function now() {
  const d = new Date();
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return h + ":" + m + " " + ap;
}
function scrollMessagesBottom() {
  requestAnimationFrame(() => { els.messages.scrollTop = els.messages.scrollHeight; });
}

/* ---------- Render: theme + wallpaper ---------- */
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  els.wallpaper.hidden = !toggleOn("ap1", true);
}

/* ---------- Render: conversation list ---------- */
function renderConvList() {
  els.convList.innerHTML = state.convs.map((c) => `
    <button class="conv${c.id === state.activeId ? " active" : ""}" data-action="selectConv" data-id="${c.id}">
      <span class="conv-avatar-wrap">
        <span class="conv-avatar" style="background:${c.color}">${esc(c.initials)}</span>
        ${c.online ? '<span class="online-dot"></span>' : ""}
      </span>
      <span class="conv-body">
        <span class="conv-row1">
          <span class="conv-name">${esc(c.name)}</span>
          <span class="conv-time">${esc(c.time)}</span>
        </span>
        <span class="conv-row2">
          <span class="conv-last">${esc(c.last)}</span>
          ${c.unread > 0 ? `<span class="unread">${c.unread}</span>` : ""}
        </span>
      </span>
    </button>`).join("");
}

/* ---------- Render: chat header + messages ---------- */
function renderChat() {
  const a = activeConv();
  if (!a) { els.messages.innerHTML = ""; return; }
  els.headAvatar.textContent = a.initials;
  els.headAvatar.style.background = a.color;
  els.headName.textContent = a.name;
  els.headPresence.textContent = a.presence;

  const raw = state.messagesByConv[state.activeId] || [];
  els.messages.innerHTML =
    '<div class="day-divider">Today</div>' +
    raw.map((m, i) => {
      const mine = !!m.mine;
      const gap = i > 0 && !!raw[i - 1].mine === mine ? "3px" : "12px";
      return `
        <div class="bubble-wrap ${mine ? "mine" : "theirs"}" style="margin-top:${gap}">
          <div class="bubble">${esc(m.text)}<span class="bubble-time">${esc(m.time)}</span></div>
        </div>`;
    }).join("");
  scrollMessagesBottom();
}

/* ---------- Conversation switching ---------- */
function selectConv(id) {
  state.activeId = id;
  state.view = "chat";
  state.menuOpen = false;
  state.searchOpen = false;
  state.modal = null;
  els.headMenu.hidden = true;
  els.chatSearch.hidden = true;
  renderModal();
  applyView();
  renderConvList();
  renderChat();
}

/* ---------- Composer ---------- */
function sendMessage() {
  const text = els.composer.value.trim();
  if (!text) return;
  els.composer.value = "";
  els.composer.style.height = "auto";

  const id = state.activeId;
  const list = state.messagesByConv[id] || (state.messagesByConv[id] = []);
  list.push({ id: Date.now(), mine: true, text, time: now() });

  const c = state.convs.find((x) => x.id === id);
  if (c) { c.last = "You: " + text; c.time = now(); }

  // === BACKEND INTEGRATION POINTS ===
  // Real send goes over the WebSocket here instead of (or alongside) the
  // local push above. See connectWebSocket() and BACKEND_TODO.md item #4/#5.
  //   ws.send(JSON.stringify({ chat_id: id, message: text }));

  renderConvList();
  renderChat();
}

/* ---------- Head menu / in-chat search ---------- */
function toggleMenu() { state.menuOpen = !state.menuOpen; els.headMenu.hidden = !state.menuOpen; }
function closeMenu() { state.menuOpen = false; els.headMenu.hidden = true; }
function openSearch() { closeMenu(); state.searchOpen = true; els.chatSearch.hidden = false; els.chatSearch.querySelector("input").focus(); }
function closeSearch() { state.searchOpen = false; els.chatSearch.hidden = true; }

/* ---------- Confirm dialogs ---------- */
function confirmBlock() {
  closeMenu(); state.modal = null; renderModal();
  state.confirm = { type: "block", title: "Block " + activeConv().name + "?",
    body: "They will no longer be able to message or call you. They will not be notified.", cta: "Block" };
  renderModal();
}
function confirmDelete() {
  closeMenu();
  state.confirm = { type: "delete", title: "Delete chat?",
    body: "This conversation will be permanently removed for you. This cannot be undone.", cta: "Delete" };
  renderModal();
}
function closeConfirm() { state.confirm = null; renderModal(); }
function doConfirm() {
  const c = state.confirm;
  if (c && c.type === "delete") {
    state.convs = state.convs.filter((x) => x.id !== state.activeId);
    state.activeId = state.convs[0] ? state.convs[0].id : null;
    state.view = "list";
    state.confirm = null;
    renderModal(); applyView(); renderConvList(); renderChat();
  } else {
    state.confirm = null; renderModal();
  }
}

/* ---------- Modals ---------- */
function openSelf() { state.modal = "self"; renderModal(); }
function openOther() { state.modal = "other"; renderModal(); }
function openSettings() { state.modal = "settings"; renderModal(); }
function closeModal() { state.modal = null; renderModal(); }

function renderModal() {
  let html = "";
  if (state.modal === "other") html += otherModalHTML();
  else if (state.modal === "self") html += selfModalHTML();
  else if (state.modal === "settings") html += settingsModalHTML();
  if (state.confirm) html += confirmModalHTML();
  els.modalRoot.innerHTML = html;
}

function otherModalHTML() {
  const a = activeConv();
  if (!a) return "";
  const tiles = ["#6b7f99", "#9a7b8e", "#7e8a6b", "#8a7f6f"];
  return `
  <div class="overlay" data-action="closeModal">
    <div class="dialog profile-dialog" data-stop>
      <div class="profile-head">
        <button class="modal-x" data-action="closeModal" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
        <div class="profile-avatar" style="background:${a.color}">${esc(a.initials)}</div>
        <div class="profile-name">${esc(a.name)}</div>
        <div class="profile-username">${esc(a.username)}</div>
        <div class="profile-presence">${esc(a.presence)}</div>
      </div>
      <div class="profile-actions">
        <button class="pa-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18.63 13A17.89 17.89 0 0 1 18 8M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14M18 8a6 6 0 0 0-9.33-5M13.73 21a2 2 0 0 1-3.46 0M1 1l22 22"/></svg>Mute</button>
        <button class="pa-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>Search</button>
        <button class="pa-btn danger" data-action="confirmBlock"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>Block</button>
      </div>
      <div class="shared">
        <div class="shared-title">Shared media</div>
        <div class="shared-grid">${tiles.map((c) => `<div class="shared-tile" style="background:${c}"></div>`).join("")}</div>
      </div>
    </div>
  </div>`;
}

function selfModalHTML() {
  const me = DATA.me;
  return `
  <div class="overlay" data-action="closeModal">
    <div class="dialog profile-dialog" data-stop style="width:360px">
      <div class="profile-head">
        <button class="modal-x" data-action="closeModal" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
        <div class="profile-avatar" style="background:#8a7f6f">${esc(me.initials)}</div>
        <div class="profile-name">${esc(me.name)}</div>
        <div class="profile-username">${esc(me.username)}</div>
        <div class="profile-bio">${esc(me.bio)}</div>
        <div class="profile-actions self">
          <button class="pa-btn primary">Edit profile</button>
          <button class="pa-btn plain" data-action="openSettings">Settings</button>
        </div>
      </div>
    </div>
  </div>`;
}

function settingsModalHTML() {
  const tab = state.settingsTab;
  const cfg = SETTINGS[tab];
  const tabs = TAB_ORDER.map((k) => `
    <button class="settings-tab${k === tab ? " active" : ""}" data-action="settingsTab" data-tab="${k}">
      ${TAB_ICONS[k]}<span>${SETTINGS[k].title}</span>
    </button>`).join("");

  let themeBlock = "";
  if (tab === "appearance") {
    themeBlock = `
      <div class="settings-subhead">Color theme</div>
      <div class="theme-list">
        ${THEME_ORDER.map((k) => {
          const t = THEMES[k]; const sel = state.theme === k;
          return `
          <button class="theme-opt${sel ? " selected" : ""}" data-action="selectTheme" data-theme="${k}">
            <span class="theme-swatches">${t.sw.map((s) => `<span style="background:${s}"></span>`).join("")}</span>
            <span class="theme-opt-body">
              <span class="theme-opt-name">${t.name}</span>
              <span class="theme-opt-note">${t.note}</span>
            </span>
            ${sel ? '<svg class="theme-check" viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>' : ""}
          </button>`;
        }).join("")}
      </div>`;
  }

  const rows = cfg.rows.map((r) => {
    const on = toggleOn(r.k, r.on);
    return `
    <div class="setting-row">
      <div>
        <div class="setting-row-label">${r.label}</div>
        <div class="setting-row-desc">${r.desc}</div>
      </div>
      <button class="toggle${on ? " on" : ""}" data-action="toggleSetting" data-key="${r.k}" aria-label="${r.label}">
        <span class="toggle-knob"></span>
      </button>
    </div>`;
  }).join("");

  return `
  <div class="overlay" data-action="closeModal">
    <div class="dialog settings-dialog" data-stop>
      <div class="settings-tabs">
        <div class="settings-tabs-title">Settings</div>
        ${tabs}
      </div>
      <div class="settings-panel">
        <div class="settings-panel-title">${cfg.title}</div>
        <div class="settings-panel-desc">${cfg.desc}</div>
        ${themeBlock}
        <div class="setting-rows">${rows}</div>
      </div>
    </div>
  </div>`;
}

function confirmModalHTML() {
  const c = state.confirm;
  return `
  <div class="overlay confirm-layer" data-action="closeConfirm">
    <div class="dialog confirm-dialog" data-stop>
      <div class="confirm-title">${esc(c.title)}</div>
      <div class="confirm-body">${esc(c.body)}</div>
      <div class="confirm-actions">
        <button class="confirm-btn cancel" data-action="closeConfirm">Cancel</button>
        <button class="confirm-btn go" data-action="doConfirm">${esc(c.cta)}</button>
      </div>
    </div>
  </div>`;
}

/* ---------- Settings actions ---------- */
function settingsTab(tab) { state.settingsTab = tab; renderModal(); }
function toggleSetting(key) {
  const def = findToggleDefault(key);
  state.toggles[key] = !toggleOn(key, def);
  if (key === "ap1") applyTheme(); // wallpaper switch is live
  renderModal();
}
function findToggleDefault(key) {
  for (const t of TAB_ORDER) {
    const row = SETTINGS[t].rows.find((r) => r.k === key);
    if (row) return row.on;
  }
  return false;
}
function selectTheme(theme) { state.theme = theme; applyTheme(); renderModal(); }

/* ---------- Responsive ---------- */
function applyView() { document.body.dataset.view = state.view; }
function backToList() { state.view = "list"; applyView(); }
function onResize() {
  const n = window.innerWidth < 768;
  if (n !== state.isNarrow) { state.isNarrow = n; applyView(); }
}

/* ---------- Action dispatch ---------- */
const ACTIONS = {
  openSelf, openOther, openSettings, closeModal, closeConfirm, doConfirm,
  toggleMenu, openSearch, closeSearch, confirmBlock, confirmDelete, backToList,
  send: sendMessage,
  selectConv: (el) => selectConv(el.dataset.id),
  settingsTab: (el) => settingsTab(el.dataset.tab),
  toggleSetting: (el) => toggleSetting(el.dataset.key),
  selectTheme: (el) => selectTheme(el.dataset.theme),
};

document.addEventListener("click", (e) => {
  // close head menu when clicking outside it
  if (state.menuOpen && !e.target.closest(".menu-wrap")) closeMenu();

  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;

  // overlay background click: only fire when the overlay itself was clicked
  if ((action === "closeModal" || action === "closeConfirm") && el.classList.contains("overlay") && e.target !== el) return;

  const fn = ACTIONS[action];
  if (fn) { e.preventDefault(); fn(el); }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (state.confirm) { closeConfirm(); return; }
    if (state.modal) { closeModal(); return; }
    if (state.searchOpen) { closeSearch(); return; }
    if (state.menuOpen) { closeMenu(); return; }
  }
});

/* composer: auto-grow + Enter to send (Shift+Enter = newline) */
els.composer.addEventListener("input", (e) => {
  const t = e.target;
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 96) + "px";
});
els.composer.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

window.addEventListener("resize", onResize);

/* ============================================================
   BACKEND INTEGRATION POINTS  (all deferred — see BACKEND_TODO.md)
   ------------------------------------------------------------
   1. GET /api/me           -> set DATA.me (own user_id needed to mark `mine`).
   2. GET /api/chats        -> replace DATA.convs (names, members, last msg, unread).
   3. GET /api/chats/{id}/messages -> fill DATA.messagesByConv[id] on selectConv.
   4. WebSocket /ws         -> live send/receive; needs structured pub/sub payloads.
   5. Send frame            -> server must trust session user_id, not client-supplied.

   Stub kept off by default. Flip USE_WS once the backend speaks the
   structured protocol described in BACKEND_TODO.md.
   ============================================================ */
const USE_WS = false;
function connectWebSocket() {
  // Direct to backend: /ws is not proxied by nginx yet (BACKEND_TODO.md #8).
  const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.hostname + ":8000/ws";
  const ws = new WebSocket(url);
  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    // Expected shape once #4 lands:
    //   { type:"message", chat_id, sender_id, sender_name, message, message_id, time_sent }
    // Route by chat_id into state.messagesByConv, then re-render if active.
    console.debug("ws message", data);
  };
  ws.onclose = () => setTimeout(connectWebSocket, 2000);
  window.__chatWs = ws;
}

/* ---------- Boot ---------- */
function init() {
  applyTheme();
  onResize();
  applyView();
  renderConvList();
  renderChat();
  if (USE_WS) connectWebSocket();
}
init();
