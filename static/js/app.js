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
    animate: new Set(),     // message_ids that just arrived live -- animated once, then cleared
    hiddenDms: {},          // { [chat_id]: last_message time_sent when it was hidden } -- see HIDDEN_DMS_KEY
    typing: {},             // { [chat_id]: { [user_id]: expiry timer } } -- see "typing indicators"
  };

  /* People picker. One dialog (#newChatDialog) and one search pipeline serve two flows,
   * because "search people, chip them, keyboard-navigate the results" is exactly the same
   * job in both: `mode` is "new" (create a conversation) or "add" (add people to the group
   * in `chatId`). Only the title, the group-name row, the submit label and the submit
   * handler differ -- everything below (debounce, AbortController, stale-response drop,
   * chips, ↑/↓/Enter/Esc/Backspace) is shared rather than written twice. */
  const picker = {
    mode: "new",    // "new" | "add"
    chatId: null,   // in "add" mode, the group being added to
    selected: [],   // [{ user_id, display_name, username, avatar_url }]
    results: [],    // last search response, minus nothing -- already-chosen rows stay, marked
    active: -1,     // keyboard cursor into results
    timer: null,    // debounce
    abort: null,    // AbortController for the in-flight search
    busy: false,    // create/add request in flight
  };

  // Group-details dialog (named so it can't be shadowed by the local `members` arrays).
  const memberPanel = {
    chatId: null,   // the group being shown; null when the dialog is closed
    busy: null,     // user_id of the row whose change_role call is in flight
  };

  // The shared confirmation dialog: `onOk` returns null on success, or a message to show.
  const confirmer = { onOk: null, busy: false };

  /* chat_ids this client asked the server to delete. The chat_deleted frame can beat the
   * 200 back, so the frame stays quiet for these and the request's own handler reports. */
  const deleting = new Set();

  // Same idea for leaving: `member_removed` also comes back to the leaver.
  const leaving = new Set();

  const $ = (id) => document.getElementById(id);
  const els = {
    meBtn: $("meBtn"), meAvatar: $("meAvatar"), meName: $("meName"), logoutBtn: $("logoutBtn"),
    newChatBtn: $("newChatBtn"), convList: $("convList"),
    backBtn: $("backBtn"), chatHead: $("chatHead"), chatInfoBtn: $("chatInfoBtn"),
    chatFace: $("chatFace"), chatTitle: $("chatTitle"), chatSub: $("chatSub"),
    connBanner: $("connBanner"), messages: $("messages"), chatEmpty: $("chatEmpty"),
    composer: $("composer"), composerInput: $("composerInput"), sendBtn: $("sendBtn"),
    sendingHint: $("sendingHint"), toast: $("toast"), typingStatus: $("typingStatus"),
    newChatDialog: $("newChatDialog"), newChatForm: $("newChatForm"), newChatError: $("newChatError"),
    newChatTitle: $("newChatTitle"),
    pickerField: $("pickerField"), pickerInput: $("pickerInput"),
    pickerChips: $("pickerChips"), pickerResults: $("pickerResults"),
    pickerStatus: $("pickerStatus"), groupNameRow: $("groupNameRow"), groupNameInput: $("groupNameInput"),
    newChatSubmit: $("newChatSubmit"),
    chatMenu: $("chatMenu"), chatMenuBtn: $("chatMenuBtn"), chatMenuList: $("chatMenuList"),
    menuMembers: $("menuMembers"), menuAddPeople: $("menuAddPeople"),
    menuRename: $("menuRename"), menuLeave: $("menuLeave"), menuDelete: $("menuDelete"),
    renameDialog: $("renameDialog"), renameForm: $("renameForm"), renameInput: $("renameInput"),
    renameError: $("renameError"), renameSubmit: $("renameSubmit"),
    membersDialog: $("membersDialog"), membersTitle: $("membersTitle"), memberList: $("memberList"),
    membersFace: $("membersFace"), membersSub: $("membersSub"),
    membersStatus: $("membersStatus"), membersError: $("membersError"),
    membersLeave: $("membersLeave"), membersAdd: $("membersAdd"), membersClose: $("membersClose"),
    membersRename: $("membersRename"), membersDelete: $("membersDelete"),
    profileDialog: $("profileDialog"), profileFace: $("profileFace"), profileName: $("profileName"),
    profileHandle: $("profileHandle"), profileLogout: $("profileLogout"), profileClose: $("profileClose"),
    profilePassword: $("profilePassword"),
    passwordDialog: $("passwordDialog"), passwordForm: $("passwordForm"),
    passwordError: $("passwordError"), passwordSubmit: $("passwordSubmit"),
    pwOld: $("pwOld"), pwNew: $("pwNew"), pwConfirm: $("pwConfirm"),
    confirmDialog: $("confirmDialog"), confirmForm: $("confirmForm"), confirmTitle: $("confirmTitle"),
    confirmCopy: $("confirmCopy"), confirmError: $("confirmError"), confirmOk: $("confirmOk"),
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
  // The hue is the spec's hash (so a person keeps their colour). Only the hue is
  // handed to CSS as --h; app.css turns it into a pastel tile with deeper initials,
  // themed per colour scheme.
  function hueFor(id) {
    let h = 0;
    for (const c of String(id)) h = c.charCodeAt(0) + ((h << 5) - h);
    return ((h % 360) + 360) % 360;
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
      style: `--h:${hueFor(seed)}`,
      "aria-hidden": "true",
    }, initials(name));
    if (url) {
      const img = el("img", { src: url, alt: "" });
      img.addEventListener("error", () => img.remove());
      node.append(img);
    }
    return node;
  }

  // SVG needs its own namespace, so the empty-state illustrations live in <template>
  // elements in the markup and are cloned rather than built by el().
  function art(id) {
    const tpl = document.getElementById(id);
    return tpl ? tpl.content.cloneNode(true) : null;
  }

  function isMine(msg) { return state.me && msg.sender_id === state.me.user_id; }
  function isGroup(chat) { return (chat.members || []).length > 2; }
  function findChat(chatId) { return state.chats.find((c) => c.chat_id === chatId); }

  /* GET /chats sends a real `is_dm` boolean on every chat, so this is exact; the
   * two-member fallback only covers a response that predates the field. Note this is
   * NOT the same question as isGroup() above, which asks "does this chat need member
   * names in the bubbles" -- a two-person *group* is a group here and a DM there. */
  function isDm(chat) {
    if (!chat) return false;
    if (typeof chat.is_dm === "boolean") return chat.is_dm;
    return (chat.members || []).length === 2;
  }

  // Every member of GET /chats carries `role`: "admin" or "user". Both members of a DM
  // are "user", so a DM never has an admin -- hence no admin-only actions on one.
  function myRole(chat) {
    if (!chat || !state.me) return null;
    const mine = (chat.members || []).find((m) => m.user_id === state.me.user_id);
    return mine ? mine.role : null;
  }
  function amAdmin(chat) { return myRole(chat) === "admin"; }
  function adminCount(chat) {
    return (chat && chat.members || []).filter((m) => m.role === "admin").length;
  }
  // The server refuses to let the last admin leave, so warn before they try.
  function amSoleAdmin(chat) { return amAdmin(chat) && adminCount(chat) === 1; }

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

  /* ---------- membership / role events (the `system` frame) ----------
   * The server sends a ready-made sentence in `message` ("Ada added Cleo"), but we build
   * our own from actor_name/target_name/event so the line can say "You" where the current
   * user is involved -- and so it stays right if a display name changes later. An `event`
   * we don't know falls back to the server's sentence verbatim, so a future event still
   * renders as something instead of vanishing.
   *
   * `member_left` is self-initiated, so actor_id === target_id: it reads off the actor
   * alone ("You left" / "Cleo left") and never mentions a target.
   *
   * `member_kicked` is an admin removing someone else, so it has a real actor and target
   * like the role events. We say "removed" rather than the server's "kicked" -- the
   * fallback sentence in `message` is wording for a client that doesn't know the event,
   * not wording we have to repeat -- which reads in all three persons: "You removed Cleo",
   * "Ada removed you", "Ada removed Cleo".
   */
  function systemText(f) {
    if (!f) return "";
    const meId = state.me ? state.me.user_id : null;
    const iActed = meId != null && f.actor_id === meId;
    const iAmTarget = meId != null && f.target_id === meId;
    const actor = iActed ? "You" : (f.actor_name || "Someone");
    const target = iAmTarget ? "you" : (f.target_name || "someone");
    switch (f.event) {
      case "member_added": return actor + " added " + target;
      case "member_left":  return actor + " left";
      case "member_kicked": return actor + " removed " + target;
      case "promoted":     return actor + " made " + target + " an admin";
      case "demoted":      return actor + " removed " + target + " as an admin";
      // A rename has no target user; its new name rides in `data` (messages.event_data),
      // which is why this can say "You" where the server's fallback sentence can't.
      case "chat_renamed": {
        const name = (f.data && f.data.new_name) || "";
        return name ? actor + " renamed the group to \u201c" + name + "\u201d"
                    : actor + " renamed the group";
      }
      default:             return String(f.message == null ? "" : f.message);
    }
  }

  /* Is this chat's sidebar preview an event line rather than something someone said?
   * KNOWN BACKEND GAP: the `last_message` in GET /chats carries the row's text and its
   * sender but no `kind`/`event`, so a system row is indistinguishable from a message
   * there. Where we do know -- a live frame marked the copy it wrote (bumpLastMessage), or
   * the row is in this chat's loaded history -- the preview uses our own second-person copy
   * and drops the "Name: " prefix a real message gets. Otherwise it falls back to the
   * server's sentence, which is still readable, just prefixed. */
  function systemLastMessage(chat) {
    const lm = chat.last_message;
    if (!lm || !lm.message_id) return null;
    if (lm.type === "system") return lm;
    const loaded = state.messagesByChat[chat.chat_id];
    const hit = loaded && loaded.find((m) => m.message_id === lm.message_id);
    return hit && hit.type === "system" ? hit : null;
  }

  /* ---------- typing indicators ----------
   * Outbound: `WS.sendTyping()` is the only frame besides a message this client publishes,
   * and every one of them is a Redis round-trip out to every other member of the chat --
   * so it is throttled on the leading edge: the first keystroke of a burst announces at
   * once, then at most one frame per TYPING_SEND_MS while the user keeps going. Never on
   * an empty composer, never for a chat that isn't the open one, never while the socket
   * is down.
   *
   * Inbound: `user_typing` carries only a chat and a user. There is NO "stopped typing"
   * frame in the protocol, so nothing will ever tell us someone finished -- each typist
   * gets a TYPING_TTL_MS timer that is reset by their next frame and otherwise expires
   * them. TTL comfortably exceeds the sender's throttle, so an indicator stays up while
   * someone is really typing and clears a few seconds after they stop.
   *
   * Frames arrive for chats that aren't open (we are registered for all of them), so the
   * state is per-chat: the open chat draws a bubble at the end of its message list, every
   * other chat renders "typing…" in place of its sidebar preview. A chat we don't know is
   * ignored rather than remembered, so the map can't grow past the sidebar.
   *
   * The visible form differs between the two, but typingText() writes the copy for both: it
   * is the sidebar's preview line AND the bubble's screen-reader equivalent (#typingStatus),
   * because the bubble itself is three animated dots and says nothing out loud.
   */
  const TYPING_TTL_MS = 5000;        // how long one `user_typing` frame keeps the line up
  const TYPING_SEND_MS = 3000;       // at most one outbound frame per chat per this long

  // The last typing frame we sent, so the throttle knows when the next one is due.
  const typingOut = { chatId: null, at: 0 };

  function typingIds(chatId) {
    const per = state.typing[chatId];
    return per ? Object.keys(per).map(Number) : [];
  }

  /* "Ada is typing…" / "Ada and Cleo are typing…" / "Ada and 2 others are typing…".
   * First names only -- this has to fit a sidebar row as well as the composer line. The
   * map's keys are user ids, which JS enumerates in ascending numeric order, so the names
   * keep their places instead of reshuffling every time a frame lands. */
  function typingText(chat) {
    if (!chat) return "";
    const names = typingIds(chat.chat_id)
      .map((id) => memberName(chat, id).split(/\s+/)[0] || "Someone");
    if (!names.length) return "";
    if (names.length === 1) return names[0] + " is typing…";
    if (names.length === 2) return names[0] + " and " + names[1] + " are typing…";
    return names[0] + " and " + (names.length - 1) + " others are typing…";
  }

  /* The indicator bubble for this chat, or null when nobody in it is typing.
   *
   * ONE bubble per chat however many people are typing -- a stack of per-person bubbles
   * would push the conversation up the screen and turn a hint into an event. Up to
   * STACK_MAX faces overlap inside it and the rest become "+N", the same shorthand the
   * group header uses, so you can still tell who it is.
   *
   * `data-typists` is the ascending id list the bubble was built from: renderTyping()
   * compares it and leaves an unchanged bubble in place, so the dots don't restart every
   * time one of the typists re-announces (every TYPING_SEND_MS, per person).
   *
   * The row is `.msg.theirs` with both group classes, i.e. a standalone received bubble --
   * never `.mine`, and never without them, or the corner radii would read as mid-run. */
  function typingBubbleEl(chat) {
    const ids = typingIds(chat.chat_id);
    if (!ids.length) return null;
    const members = chat.members || [];
    const faces = el("span", { class: "typing-faces" });
    for (const id of ids.slice(0, STACK_MAX)) {
      const m = members.find((x) => x.user_id === id);
      faces.append(avatarEl(memberName(chat, id), "user:" + id, m && m.avatar_url, "avatar-sm"));
    }
    const rest = ids.length - STACK_MAX;
    if (rest > 0) faces.append(el("span", { class: "stack-more" }, "+" + rest));
    return el("div", {
      class: "msg theirs group-start group-end typing-msg",
      id: "typingBubble",
      "data-typists": ids.join(","),
      "aria-hidden": "true",            // #typingStatus is the spoken copy
    },
      faces,
      el("div", { class: "msg-col" },
        el("div", { class: "bubble typing-bubble" },
          el("span", { class: "typing-dots" }, el("i"), el("i"), el("i")))));
  }

  // renderMessages() wipes the list, so it puts the bubble back itself.
  function appendTypingBubble(box, chat) {
    const node = typingBubbleEl(chat);
    if (node) box.append(node);
  }

  /* Between full renders this adds, swaps or removes the bubble in place -- and it owns the
   * scroll anchoring that comes with growing or shrinking the list from the bottom, because
   * the bubble now lives in the scroll container rather than over it. The rule is the one
   * renderMessages() already follows for an incoming message: follow the bottom only if the
   * reader was already there, otherwise don't touch scrollTop. Swapping one bubble for
   * another needs no anchoring at all -- same row, same height.
   *
   * #typingStatus is a permanent live region whose text changes, rather than an element that
   * appears and disappears, which is what makes the announcement reliable; it is only
   * written when the sentence actually differs, so an unchanged state can't re-announce. */
  function renderTyping() {
    const chat = state.activeChatId ? findChat(state.activeChatId) : null;
    const text = chat ? typingText(chat) : "";
    if (els.typingStatus.textContent !== text) els.typingStatus.textContent = text;

    const box = els.messages;
    const existing = $("typingBubble");
    const wanted = chat && !box.hidden ? typingBubbleEl(chat) : null;

    if (!wanted) {
      if (!existing) return;
      const atBottom = nearBottom();
      existing.remove();
      if (atBottom) scrollToBottom();
      return;
    }
    if (existing) {
      if (existing.dataset.typists === wanted.dataset.typists) return;
      existing.replaceWith(wanted);
      return;
    }
    const atBottom = nearBottom();
    box.append(wanted);
    if (atBottom) scrollToBottom();
  }

  // Each of these reports whether it actually changed anything, so callers can skip a
  // render on an expiry timer that had already been overtaken.
  function clearTypist(chatId, userId) {
    const per = state.typing[chatId];
    if (!per || !Object.prototype.hasOwnProperty.call(per, userId)) return false;
    clearTimeout(per[userId]);
    delete per[userId];
    if (!Object.keys(per).length) delete state.typing[chatId];
    return true;
  }

  function clearTyping(chatId) {
    const per = state.typing[chatId];
    if (!per) return false;
    for (const id of Object.keys(per)) clearTimeout(per[id]);
    delete state.typing[chatId];
    return true;
  }

  // Switching chats and losing the socket both invalidate every indicator at once.
  function clearAllTyping() {
    let any = false;
    for (const id of Object.keys(state.typing)) any = clearTyping(id) || any;
    typingOut.chatId = null;
    typingOut.at = 0;
    return any;
  }

  function noteTyping(chatId, userId) {
    if (userId == null || !findChat(chatId)) return;          // unknown chat: nothing to show
    if (state.me && userId === state.me.user_id) return;      // the server skips us; belt and braces
    const per = state.typing[chatId] || (state.typing[chatId] = {});
    clearTimeout(per[userId]);
    per[userId] = setTimeout(() => {
      if (!clearTypist(chatId, userId)) return;
      renderTyping();
      renderChatList();
    }, TYPING_TTL_MS);
    renderTyping();
    renderChatList();
  }

  // Called on every keystroke; the throttle decides whether anything goes out.
  function maybeSendTyping() {
    const chatId = state.activeChatId;
    if (!chatId || state.wsStatus !== "open") return;
    if (!els.composerInput.value.trim()) return;              // nothing typed, nothing to announce
    const now = Date.now();
    if (typingOut.chatId === chatId && now - typingOut.at < TYPING_SEND_MS) return;
    if (!WS.sendTyping(chatId)) return;
    typingOut.chatId = chatId;
    typingOut.at = now;
  }

  /* ---------- locally hidden DMs ----------
   * POST /chat/delete_chat refuses a DM, so "Delete for me" can only hide one: the
   * chat_id goes into localStorage and the sidebar filters it out. This is per-browser
   * by design -- there is no server-side state behind it, so the same DM is still
   * listed on the user's other devices, and it reappears here if site data is cleared.
   *
   * It is also only "clear it from my list for now", WhatsApp-style, not a block: any
   * new activity un-hides it (see unhideDm's callers -- the inbound `message` frame, the
   * pending-messages replay, and a refresh whose unread count or last_message moved on).
   * The stored value is the chat's last_message time at the moment it was hidden, which
   * is the watermark that "moved on" is measured against.
   *
   * Every localStorage access is guarded: it throws in private mode and when site data
   * is blocked. When it is unavailable the in-memory map still works, so hiding simply
   * lasts for the life of the page instead of forever.
   */
  const HIDDEN_DMS_KEY = "chatapp.hiddenDms";

  function loadHiddenDms() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(HIDDEN_DMS_KEY) || "null");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out = {};
        for (const [id, mark] of Object.entries(parsed)) out[id] = typeof mark === "string" ? mark : "";
        return out;
      }
    } catch (_) { /* unavailable, blocked, or corrupt -- start with nothing hidden */ }
    return {};
  }

  function saveHiddenDms() {
    try {
      window.localStorage.setItem(HIDDEN_DMS_KEY, JSON.stringify(state.hiddenDms));
    } catch (_) { /* unavailable: the in-memory map still drives this session */ }
  }

  function isHidden(chatId) {
    return Object.prototype.hasOwnProperty.call(state.hiddenDms, chatId);
  }

  function hideDm(chat) {
    state.hiddenDms[chat.chat_id] = hasLastMessage(chat) ? String(chat.last_message.time_sent) : "";
    saveHiddenDms();
  }

  function unhideDm(chatId) {
    if (!isHidden(chatId)) return false;
    delete state.hiddenDms[chatId];
    saveHiddenDms();
    return true;
  }

  // Has anything happened in this hidden chat since it was hidden?
  function newsSinceHidden(chat) {
    if ((chat.unread_message_count || 0) > 0) return true;
    if (!hasLastMessage(chat)) return false;
    const mark = state.hiddenDms[chat.chat_id];
    if (!mark) return true;                       // hidden while empty, has messages now
    const then = parseTime(mark);
    const now = parseTime(chat.last_message.time_sent);
    if (isNaN(then) || isNaN(now)) return true;   // can't compare -> assume there's news
    return now > then;
  }

  // The sidebar (and the desktop auto-select on boot) only ever sees these.
  function visibleChats() {
    return state.chats.filter((c) => !isHidden(c.chat_id));
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
    // An event is a last_message like any other; keep what systemLastMessage() needs,
    // since GET /chats won't tell us this row was one.
    if (m.type === "system") {
      Object.assign(chat.last_message, {
        type: "system", event: m.event,
        actor_id: m.actor_id, actor_name: m.actor_name,
        target_id: m.target_id, target_name: m.target_name,
      });
    }
  }

  /* ---------- rendering: sidebar ---------- */
  function renderMe() {
    const name = state.me.display_name || state.me.user;
    els.meName.textContent = name;
    const next = avatarEl(name, "user:" + state.me.user_id, state.me.avatar_url, "avatar-sm");
    next.id = "meAvatar";
    els.meAvatar.replaceWith(next);
    els.meAvatar = next;
  }

  function renderChatList() {
    const list = els.convList;
    const chats = visibleChats();
    list.replaceChildren();
    if (!chats.length) {
      const stage = el("div", { class: "stage" },
        el("div", { class: "stage-art" }),
        el("h2", { class: "stage-title" }, "No conversations"),
        el("p", { class: "stage-copy" }, "Your conversations will appear here."),
        el("button", { type: "button", class: "btn primary", onclick: openNewChat }, "New conversation"));
      const a = art("artNoChats");
      if (a) stage.firstChild.append(a);
      list.append(stage);
      return;
    }
    for (const chat of chats) {
      const title = chatTitle(chat);
      let preview = "No messages yet";
      let time = "";
      let timeTitle = "";
      if (hasLastMessage(chat)) {
        const lm = chat.last_message;
        const sys = systemLastMessage(chat);
        if (sys) {
          preview = systemText(sys);          // "You left" -- nobody said it, so nobody is named
        } else {
          const who = lm.sender_id === state.me.user_id ? "You: "
            : isGroup(chat) ? memberName(chat, lm.sender_id).split(/\s+/)[0] + ": " : "";
          preview = who + lm.message;
        }
        const d = parseTime(lm.time_sent);
        time = fmtCoarse(d);
        timeTitle = fullStamp(d);
      }
      /* Someone typing right now is newer than any last_message, so it wins the preview
       * line -- including for a chat that isn't open, which is the only place a typing
       * frame for a background chat is visible. The time stays put. */
      const typing = typingText(chat);
      if (typing) preview = typing;
      const unread = chat.unread_message_count > 0;
      list.append(el("button", {
        type: "button",
        class: "conv" + (chat.chat_id === state.activeChatId ? " active" : "") + (unread ? " unread" : ""),
        "data-chat": chat.chat_id,
      },
        avatarEl(title, chatAvatarSeed(chat), (otherMember(chat) || {}).avatar_url),
        el("span", { class: "conv-main" },
          el("span", { class: "conv-name-row" },
            unread ? el("span", { class: "conv-dot", "aria-hidden": "true" }) : null,
            el("span", { class: "conv-name" }, title)),
          el("span", { class: "conv-preview" }, preview)),
        el("span", { class: "conv-side" },
          el("span", { class: "conv-time", title: timeTitle || null }, time),
          unread ? el("span", { class: "badge" }, String(chat.unread_message_count)) : null),
      ));
    }
  }

  /* ---------- rendering: chat pane ---------- */
  const STACK_MAX = 3;

  function renderHeader(chat) {
    renderChatMenu(chat);
    if (!chat) {
      els.chatHead.hidden = true;
      els.chatTitle.textContent = "";
      els.chatSub.textContent = "";
      els.chatFace.replaceChildren();
      return;
    }
    els.chatHead.hidden = false;
    const title = chatTitle(chat);
    els.chatTitle.textContent = title;
    els.chatFace.replaceChildren();

    const other = otherMember(chat);
    if (!isGroup(chat)) {
      // DM (or a degenerate one-member chat): just the other person. /chats members
      // carry no username, so there is nothing honest to put in the subtitle.
      els.chatFace.append(avatarEl(title, chatAvatarSeed(chat), other && other.avatar_url, "avatar-sm"));
      els.chatSub.textContent = "";
      return;
    }
    // Group: a stack of up to three member avatars, then "+N".
    const members = chat.members || [];
    const others = members.filter((m) => m.user_id !== state.me.user_id);
    for (const m of others.slice(0, STACK_MAX)) {
      els.chatFace.append(avatarEl(m.display_name, "user:" + m.user_id, m.avatar_url, "avatar-sm"));
    }
    const rest = others.length - STACK_MAX;
    if (rest > 0) els.chatFace.append(el("span", { class: "stack-more" }, "+" + rest));
    els.chatSub.textContent = members.length + " members";
  }

  function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  /* "Is the reader at the end of the conversation?" -- the one test behind every decision to
   * follow new content down, whether that content is a message, an event line or the typing
   * bubble. The slack absorbs sub-pixel scroll heights and the last line's leading. */
  const BOTTOM_SLACK = 80;
  function nearBottom() {
    const box = els.messages;
    return box.scrollHeight - box.scrollTop - box.clientHeight < BOTTOM_SLACK;
  }

  /* One centred, full-width divider line -- no bubble, no avatar, no side -- so an event
   * can't be mistaken for something a person said. The time carries the same `title`
   * tooltip as a bubble's .meta stamp, built by the same fullStamp(). */
  function systemLineEl(m, d) {
    const stamp = fullStamp(d);
    const time = isNaN(d) ? "" : fmtTime(d);
    return el("div", {
      class: "sys" + (state.animate.has(m.message_id) ? " enter" : ""),
    },
      el("span", { class: "sys-text", title: stamp || null },
        systemText(m),
        time ? el("span", { class: "sys-time" }, time) : null));
  }

  // mode: "bottom" (jump to end) | "stick" (stay at end only if already there) | "prepend" (keep viewport)
  function renderMessages(chatId, mode = "bottom") {
    const box = els.messages;
    const msgs = state.messagesByChat[chatId];
    const chat = findChat(chatId);
    const group = chat ? isGroup(chat) : false;

    const prevHeight = box.scrollHeight;
    const prevTop = box.scrollTop;
    const wasAtBottom = nearBottom();

    box.replaceChildren();

    if (!msgs) {
      box.append(el("div", { class: "messages-note" }, "Loading…"));
      if (chat) appendTypingBubble(box, chat);
      return;
    }
    if (state.hasMoreByChat[chatId] || state.loadingHistory[chatId]) {
      box.append(el("div", { class: "messages-note", id: "loadOlder" },
        state.loadingHistory[chatId] ? "Loading earlier messages…" : ""));
    }
    if (!msgs.length) {
      const who = chat ? chatTitle(chat) : "them";
      const stage = el("div", { class: "stage" },
        el("div", { class: "stage-art" }),
        el("h2", { class: "stage-title" }, "Start of your conversation with " + who),
        el("p", { class: "stage-copy" }, "No messages yet. Send the first one below."));
      const a = art("artSayHi");
      if (a) stage.firstChild.append(a);
      box.append(stage);
    }

    let prev = null;
    let prevDate = null;
    msgs.forEach((m, i) => {
      const d = parseTime(m.time_sent);
      const next = msgs[i + 1];
      const nextDate = next ? parseTime(next.time_sent) : null;
      const newDay = !prev || !sameDay(prevDate, d);
      if (newDay) box.append(el("div", { class: "day" }, fmtDay(d)));

      /* An event still becomes `prev`, and it carries no sender_id, so the bubble that
       * follows it always reads as a group start and the bubble before it as a group end
       * (which is also what makes that one show its timestamp). An event visibly breaks a
       * run, which is exactly what a divider is for. */
      if (m.type === "system") {
        box.append(systemLineEl(m, d));
        prev = m;
        prevDate = d;
        return;
      }

      const groupStart = newDay || prev.sender_id !== m.sender_id || d - prevDate > GROUP_GAP_MS;
      const groupEnd = !next || next.sender_id !== m.sender_id || !sameDay(d, nextDate) || nextDate - d > GROUP_GAP_MS;
      const mine = isMine(m);
      const text = String(m.message == null ? "" : m.message);
      const oneLine = !text.includes("\n") && text.length <= 60;
      const stamp = fullStamp(d);

      const col = el("div", { class: "msg-col" });
      if (groupStart && !mine && group) col.append(el("div", { class: "sender" }, m.sender_name));
      col.append(el("div", { class: "bubble" + (oneLine ? " one-line" : "") }, text));
      // The last bubble of a run always shows its time; the rest hang one beside
      // the bubble that fades in on hover.
      if (groupEnd) col.append(el("div", { class: "meta", title: stamp }, fmtTime(d)));

      const row = el("div", {
        class: "msg" + (mine ? " mine" : " theirs") + (groupStart ? " group-start" : "")
          + (groupEnd ? " group-end" : "") + (state.animate.has(m.message_id) ? " enter" : ""),
      });
      const aside = groupEnd ? null : el("div", { class: "meta aside", title: stamp }, fmtTime(d));
      if (mine && aside) row.append(aside);
      row.append(col);
      if (!mine && aside) row.append(aside);
      box.append(row);

      prev = m;
      prevDate = d;
    });
    state.animate.clear();

    /* Last thing in the list, below the newest message -- and appended before the scroll
     * decision below, so "bottom"/"stick" land past it instead of just above it. */
    if (chat) appendTypingBubble(box, chat);

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
    if (!hasChat) renderHeader(null);      // no chat, no header bar
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
    unhideDm(chatId);              // deliberately opening a hidden DM brings it back
    /* Every indicator is stale the moment the view changes: a line from the chat we just
     * left must not survive the switch, and a frame that landed seconds ago shouldn't
     * greet us in the new one. Whoever is still typing re-announces within TYPING_SEND_MS.
     * This also resets the outbound throttle, so our first keystroke here announces. */
    clearAllTyping();
    document.body.dataset.view = "chat";
    renderChatList();
    renderHeader(chat);
    showChatPane(true);
    renderMessages(chatId, "bottom");
    renderTyping();
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
      // The chat may have been deleted out from under us while the page was in flight.
      if (!findChat(chatId)) return false;
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
        /* Same row, but the fresh copy lost the marker that says it was an event (see
         * systemLastMessage) -- keep the one we already recognised. */
        if (old && hasLastMessage(old) && hasLastMessage(c)
            && old.last_message.type === "system"
            && old.last_message.message_id === c.last_message.message_id) {
          c.last_message = old.last_message;
        }
      }
      // A locally hidden DM comes back as soon as there is something new in it, and a
      // chat that no longer exists has nothing left to hide.
      for (const id of Object.keys(state.hiddenDms)) {
        const c = fresh.find((x) => x.chat_id === id);
        if (!c || newsSinceHidden(c)) unhideDm(id);
      }
      state.chats = fresh;
      sortChats();
      renderChatList();
      if (state.activeChatId && !findChat(state.activeChatId)) clearSelection();
      // Roles, names and membership may all have moved -- the header and its menu read them.
      else if (state.activeChatId) renderHeader(findChat(state.activeChatId));
      if (memberPanel.chatId) renderMembers();
    } catch (e) {
      if (!e.redirected) toast(e.message || "Couldn't load chats");
    }
  }

  // Nothing is open any more: drop back to the empty state (and, on mobile, to the list,
  // since the chat pane has nothing left to show).
  function clearSelection() {
    state.activeChatId = null;
    showChatPane(false);                  // also clears the header and its menu
    renderTyping();                       // no open chat -> no indicator
    updateComposer();
    if (!DESKTOP.matches) document.body.dataset.view = "list";
  }

  /* Forget a chat completely: its sidebar row, every cached page of its messages and the
   * selection if it was open. Idempotent on purpose -- the deleter gets the chat_deleted
   * frame too and has usually cleaned up already, and the frame can also arrive twice or
   * for a chat this client never loaded. Returns whether the chat was actually known. */
  function dropChat(chatId) {
    const had = !!findChat(chatId);
    state.chats = state.chats.filter((c) => c.chat_id !== chatId);
    delete state.messagesByChat[chatId];
    delete state.hasMoreByChat[chatId];
    delete state.loadingHistory[chatId];
    delete state.liveBuffer[chatId];
    clearTyping(chatId);                  // its timers would outlive the chat itself
    unhideDm(chatId);                     // gone for good; no point remembering it's hidden
    if (memberPanel.chatId === chatId && els.membersDialog.open) els.membersDialog.close();
    if (state.activeChatId === chatId) clearSelection();
    renderChatList();
    renderTyping();
    return had;
  }

  // How long to wait for the server's ack before assuming the frame went nowhere.
  const ACK_TIMEOUT_MS = 8000;
  let sendingTimer = null;

  function armAckTimeout() {
    clearTimeout(sendingTimer);
    sendingTimer = setTimeout(() => {
      if (state.sending === 0) return;
      // The socket reports open but nothing came back. That happens when the server
      // accepted a second socket for this user and never serviced it -- the frame
      // went into a black hole. Reconnecting gets us a socket that is actually read.
      state.sending = 0;
      updateComposer();
      toast("Couldn't confirm that message — reconnecting");
      WS.reconnect();
    }, ACK_TIMEOUT_MS);
  }

  function sendCurrent() {
    const text = els.composerInput.value.trim();
    if (!text || !state.activeChatId) return;
    if (!WS.sendMessage(state.activeChatId, text)) {
      toast("Not connected — try again in a moment");
      return;
    }
    els.composerInput.value = "";
    autoGrow();
    /* The composer is empty again, so nothing more goes out until the user types -- and
     * the next burst should announce immediately rather than waiting out the throttle
     * window this send fell inside. */
    typingOut.chatId = null;
    typingOut.at = 0;
    state.sending++;
    updateComposer();
    armAckTimeout();
  }

  function autoGrow() {
    const ta = els.composerInput;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, COMPOSER_MAX_HEIGHT) + "px";
  }

  // Reachable from the sidebar foot's icon button and from the profile card; both are
  // disabled so a second click can't fire while the request and the redirect are in flight.
  async function logout() {
    els.logoutBtn.disabled = true;
    els.profileLogout.disabled = true;
    WS.stop();
    try { await API.logout(); } catch (_) { /* already logged out */ }
    location.replace("/login/");
  }

  /* ---------- your own profile ----------
   * READ-ONLY, and not an oversight: POST /profile in app/routers/users.py is an unfinished
   * stub -- it validates the body, assigns `display_name` and `avatar_url` to locals and
   * then does nothing, with no DB write and no response. There is nothing to submit to, so
   * this card shows what GET /me returned and offers the one action that does work (log
   * out). Don't add an edit form, or an API.updateProfile(), until the endpoint exists.
   */
  function openProfile() {
    if (!state.me) return;
    const name = state.me.display_name || state.me.user;
    els.profileFace.replaceChildren(
      avatarEl(name, "user:" + state.me.user_id, state.me.avatar_url, "avatar-xl"));
    els.profileName.textContent = name;
    /* `user` is the username and `display_name` the shown name -- two different fields from
     * GET /me, so the handle is worth its own line. It collapses (`.profile-handle:empty`)
     * if /me ever answers without one. */
    els.profileHandle.textContent = state.me.user ? "@" + state.me.user : "";
    els.profileDialog.showModal();
    els.profileClose.focus();          // never land on "Log out"
  }

  /* ---------- changing your own password ----------
   * The one account edit with a working endpoint behind it, so it is the one thing the
   * profile card can do rather than just show. It opens on top of the profile card, which
   * stays underneath, the same way #renameDialog sits over the info panel.
   *
   * Nothing here is trimmed. Leading and trailing spaces are part of a password, and the
   * server's rule rejects whitespace anywhere -- trimming would quietly turn a password the
   * server refuses into a different one it accepts, and the user would then be unable to
   * log in with what they typed.
   */
  function clearPasswordFields() {
    els.pwOld.value = "";
    els.pwNew.value = "";
    els.pwConfirm.value = "";
  }

  function openPassword() {
    els.passwordError.textContent = "";
    clearPasswordFields();
    els.passwordSubmit.disabled = false;
    els.passwordDialog.showModal();
    els.pwOld.focus();
  }

  async function submitPassword(ev) {
    ev.preventDefault();
    if (els.passwordSubmit.disabled) return;
    const current = els.pwOld.value;
    const next = els.pwNew.value;
    const again = els.pwConfirm.value;

    /* Checked in the order the user reads the form, so the message always points at the
     * first field that needs attention -- and each one focuses it. The server would answer
     * 422 for a missing field and 403 for the other two; none of that needs a round trip. */
    if (!current) {
      els.passwordError.textContent = "Enter your current password.";
      els.pwOld.focus();
      return;
    }
    if (!next || !again) {
      els.passwordError.textContent = "Enter your new password twice.";
      (next ? els.pwConfirm : els.pwNew).focus();
      return;
    }
    if (!PW_RULE.test(next)) {
      els.passwordError.textContent = PW_HINT;
      els.pwNew.focus();
      els.pwNew.select();
      return;
    }
    if (next !== again) {
      els.passwordError.textContent = "The new passwords don't match.";
      els.pwConfirm.focus();
      els.pwConfirm.select();
      return;
    }

    els.passwordSubmit.disabled = true;
    els.passwordError.textContent = "";
    try {
      await API.changePassword(current, next, again);
      /* The session is untouched by this: the JWT keeps its 10h and the refresh token pair
       * is not rotated or revoked, server-side or here. So we stay signed in and say
       * nothing about other devices -- they stay signed in too. */
      els.passwordDialog.close();        // the dialog's "close" handler wipes the fields
      toast("Password changed");
    } catch (e) {
      if (e && e.redirected) return;     // session expired; apiFetch is already navigating
      els.passwordError.textContent = friendly(e, "Couldn't change your password.");
      els.passwordSubmit.disabled = false;
    }
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
      } else {
        /* Nothing will expire these for us while the socket is down, and whoever was
         * typing may well have finished by the time it comes back. */
        if (clearAllTyping()) { renderTyping(); renderChatList(); }
      }
      updateConnBanner();
      updateComposer();
    });

    WS.on("message", (m) => {
      const chat = findChat(m.chat_id);
      if (!chat) { refreshChats(); return; }
      unhideDm(m.chat_id);          // activity brings a locally hidden DM back into the list
      clearTypist(m.chat_id, m.sender_id);   // they said it; they're done typing it
      if (storeIncoming(m.chat_id, [m]) > 0) state.animate.add(m.message_id);
      bumpLastMessage(chat, m);
      const mine = isMine(m);
      if (!mine && m.chat_id !== state.activeChatId) chat.unread_message_count = (chat.unread_message_count || 0) + 1;
      sortChats();
      renderChatList();
      renderTyping();
      if (m.chat_id === state.activeChatId) renderMessages(m.chat_id, mine ? "bottom" : "stick");
    });

    /* ---- user_typing ----
     * One frame per typist per throttle window, never echoed to the typist themselves, and
     * with no "stopped" frame to follow it -- noteTyping() arms the expiry that stands in
     * for one. A frame for a chat that isn't open still lands in state and shows up as
     * that chat's sidebar preview. */
    WS.on("user_typing", (f) => {
      if (!f || !f.chat_id) return;
      noteTyping(f.chat_id, f.user_id);
    });

    /* ---- chat_renamed ----
     * Fanned out to every member of a chat whose name an admin changed (there is no rename
     * UI in this client, but the frame still has to land somewhere or the old name sticks
     * until the next GET /chats). The frame carries the new name, so patch it in place
     * rather than refetching -- a refresh is only needed for a chat we don't have.
     * A DM is never renamed server-side, and its title comes from the other person anyway. */
    WS.on("chat_renamed", (f) => {
      if (!f || !f.chat_id || typeof f.new_name !== "string") return;
      const chat = findChat(f.chat_id);
      if (!chat) { refreshChats(); return; }
      if (chat.chat_name === f.new_name) return;
      chat.chat_name = f.new_name;
      renderChatList();
      if (f.chat_id === state.activeChatId) renderHeader(chat);
      if (memberPanel.chatId === f.chat_id) renderMembers();
    });

    /* ---- system (membership/role) frames ----
     * Treated exactly like a message as far as the timeline goes: stored, de-duped and
     * ordered by time_sent, then drawn by the one renderer, so a reload looks like what
     * the user just watched happen. Nothing is synthesized locally when *we* act -- the
     * frame (or history) is the only thing that puts a line on screen, same as own
     * messages. These rows write no message_status, so they never touch unread counts.
     *
     * They are also the first notice every *watching* member gets that the roster moved
     * (`member_added` / `member_removed` only reach the one person they are about), so this
     * is the right moment to re-read GET /chats for roles and the header's member count. */
    WS.on("system", (f) => {
      if (!f || !f.chat_id) return;
      const chat = findChat(f.chat_id);
      if (!chat) { refreshChats(); return; }      // an event in a chat we don't have yet
      if (storeIncoming(f.chat_id, [f]) > 0) state.animate.add(f.message_id);
      bumpLastMessage(chat, f);
      sortChats();
      renderChatList();
      if (f.chat_id === state.activeChatId) {
        // We caused it -> follow it down; somebody else did -> only if already at the end.
        const mine = !!state.me && f.actor_id === state.me.user_id;
        renderMessages(f.chat_id, mine ? "bottom" : "stick");
      }
      refreshChats();
    });

    WS.on("chat_created", (f) => {
      /* This frame never opens a chat, it only pulls the sidebar entry in -- whether we
       * created the chat or someone else added us. Opening is the job of the POST
       * /create_chat response, which now carries the chat_id, so the frame and the
       * response can arrive in either order without double-selecting or fighting over
       * state.activeChatId. */
      if (!findChat(f.chat_id)) refreshChats();
    });

    WS.on("chat_deleted", (f) => {
      /* Pushed to every member with a live socket when a group is deleted -- the deleter
       * included, who has usually cleaned up already after the 200. dropChat() is
       * idempotent, so this only has to decide whether there is anything to say. */
      if (!f || !f.chat_id) return;
      const wasActive = state.activeChatId === f.chat_id;
      const chat = findChat(f.chat_id);
      const name = chat ? chatTitle(chat) : null;
      if (!dropChat(f.chat_id)) return;                  // already gone: nothing happened here
      if (deleting.has(f.chat_id)) return;               // our own delete; it does the talking
      // Worth saying either way, but especially if it just vanished from under them.
      toast(wasActive ? "“" + name + "” was deleted" : "“" + name + "” was deleted by an admin");
    });

    /* ---- membership frames ----
     * KNOWN BACKEND LIMITATION, not a frontend bug: `member_added` and `member_removed`
     * are published to the ONE user they are about and to nobody else. When an admin adds
     * C to a group, A and B are never told, so their `members` arrays (and the header's
     * member count, and this panel) stay stale until their next GET /chats. There is no
     * members endpoint, so /chats is the only cure. Consequences, all handled:
     *   - the acting admin refreshes by hand after its own 200 (submitAddPeople, leaveGroup);
     *   - a `member_added` here means *we* were added, possibly to a chat we have never
     *     seen -- refresh so it appears in the sidebar;
     *   - a `member_removed` here means *we* are out, so the chat is gone for us.
     * Everyone else just finds out late, on their next refresh (a reconnect does one).
     */
    WS.on("member_added", async (f) => {
      if (!f || !f.chat_id) return;
      const known = !!findChat(f.chat_id);
      await refreshChats();
      const chat = findChat(f.chat_id);
      // Only worth announcing when it really is new to us -- being added is otherwise
      // indistinguishable from the membership churn of a chat we already have open.
      if (!known && chat) toast("You were added to “" + chatTitle(chat) + "”");
    });

    WS.on("member_removed", (f) => {
      /* Reaches the leaver after their own 200 as well, so take the same line as
       * chat_deleted: dropChat() is idempotent and `leaving` keeps the frame from
       * toasting over the message leaveGroup() already showed. */
      if (!f || !f.chat_id) return;
      const chat = findChat(f.chat_id);
      const name = chat ? chatTitle(chat) : null;
      if (!dropChat(f.chat_id)) return;                  // already gone: nothing to say
      if (leaving.has(f.chat_id)) return;                // our own leave; it does the talking
      toast("You're no longer in “" + name + "”");
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
        unhideDm(chatId);           // offline-delivered messages count as activity too
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
      if (state.sending === 0) clearTimeout(sendingTimer);
      updateComposer();
    });

    WS.on("error", (e) => {
      /* An error frame says nothing about which frame it answers, but the wording pins
       * this one down: the server refuses a control frame for a chat the socket isn't
       * registered for with exactly this detail, and `typing` is the only control frame we
       * ever send (a refused message frame comes back with its own wording). A typing
       * frame that didn't land is not worth telling the user about, and it must not be
       * counted against a message still waiting for its ack. */
      if (e && e.detail === "Something Went Wrong") return;
      if (state.sending > 0) state.sending--;
      if (state.sending === 0) clearTimeout(sendingTimer);
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

  /* The one entry point into the picker dialog. `mode` picks which flow submits it; in
   * "add" mode the dialog is opened on top of the group-details panel, which stays
   * underneath (the same stacking "Step down" already relies on). */
  function openPeoplePicker({ mode, chatId, title }) {
    cancelSearch();
    picker.mode = mode;
    picker.chatId = chatId || null;
    picker.selected = [];
    picker.results = [];
    picker.active = -1;
    picker.busy = false;
    els.newChatTitle.textContent = title;
    els.pickerInput.value = "";
    els.groupNameInput.value = "";
    els.newChatError.textContent = "";
    els.pickerStatus.textContent = "";
    renderPicker();
    if (!els.newChatDialog.open) els.newChatDialog.showModal();
    els.pickerInput.focus();
  }

  function openNewChat() {
    openPeoplePicker({ mode: "new", title: "New conversation" });
  }

  // Admin-only, group-only: adds people to the chat the panel/menu is about.
  function openAddPeople(chat) {
    const target = chat || findChat(state.activeChatId);
    if (!target || isDm(target) || !amAdmin(target)) return;
    // chat_name can be 255 characters; the dialog heading is display type, so clamp it
    // rather than letting one group push the whole card down the screen.
    const name = chatTitle(target);
    openPeoplePicker({
      mode: "add",
      chatId: target.chat_id,
      title: "Add people to “" + (name.length > 36 ? name.slice(0, 35).trimEnd() + "…" : name) + "”",
    });
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
    const adding = picker.mode === "add";
    els.groupNameRow.hidden = adding || n < 2;             // a DM's title comes from its members
    els.newChatSubmit.textContent = adding
      ? (n > 1 ? "Add " + n + " people" : "Add")
      : (n >= 2 ? "Create group" : "Message");
    els.newChatSubmit.disabled = n === 0 || picker.busy;
    els.newChatDialog.classList.toggle("has-chips", n > 0);
  }

  /* In "add" mode the people already in the group come back from the search like anyone
   * else (the endpoint only excludes the caller), so they are shown but not selectable --
   * clearer than silently dropping them, which reads as "that person doesn't exist". */
  function alreadyInChat(userId) {
    if (picker.mode !== "add") return false;
    const chat = findChat(picker.chatId);
    return !!chat && (chat.members || []).some((m) => m.user_id === userId);
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
      const inChat = alreadyInChat(u.user_id);
      const already = inChat || chosen.has(u.user_id);
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
        already ? el("span", { class: "picker-row-tag" }, inChat ? "Already in" : "Added") : null));
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
    if (alreadyInChat(u.user_id)) return;      // marked "Already in"; Enter/click are no-ops
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

  /* GET /chats now carries `is_dm`, so "the DM with this person" is exact: it no longer
   * matches a two-person *group* that happens to include them, which is what the old
   * members.length === 2 guess did. A locally hidden DM still counts -- messaging that
   * person again is exactly the activity that should bring it back (selectChat below
   * un-hides it), not a reason to create a second one the server would 409 anyway. */
  function findDmWith(userId) {
    return state.chats.find(
      (c) => isDm(c) && (c.members || []).some((m) => m.user_id === userId));
  }

  /* POST /create_chat returns { chat_id }, so there is nothing to guess any more: refresh
   * for the chat's members and metadata, then open it. The old snapshot-diffing
   * adoptNewChat() is gone with the guesswork, and with it the awaitingNewChat/claimed
   * staleness dance -- this is the only path that selects a newly created chat, so it
   * cannot race the chat_created frame (which just refreshes the sidebar). The refresh is
   * skipped when that frame already brought the chat in. */
  async function openCreatedChat(chatId) {
    if (!chatId) return false;
    if (!findChat(chatId)) await refreshChats();
    if (!findChat(chatId)) return false;
    await selectChat(chatId);
    els.composerInput.focus();
    return true;
  }

  // One <form>, two flows -- see the comment on `picker`.
  function submitPicker(ev) {
    ev.preventDefault();
    if (picker.mode === "add") submitAddPeople();
    else submitNewChat();
  }

  async function submitNewChat() {
    if (picker.busy || !picker.selected.length) return;
    els.newChatError.textContent = "";
    const chosen = picker.selected.slice();
    const isDm = chosen.length === 1;

    // The server rejects a duplicate DM itself (chats.dm_key is UNIQUE) with a 409, which
    // the catch below recovers from -- this check just saves that round trip when the chat
    // is already in our list. Groups are deliberately not deduped, here or server-side.
    if (isDm) {
      const existing = findDmWith(chosen[0].user_id);
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
    try {
      const res = await API.createChat({ chat_name: name, chat_users: chosen.map((u) => u.user_id), is_dm: isDm });
      closePicker();
      if (!(await openCreatedChat(res && res.chat_id))) toast("Conversation created, but it didn't show up yet.");
    } catch (e) {
      if (e && e.redirected) return;
      /* 409 means the DM exists server-side but wasn't in state.chats when the pre-check
       * ran (another device made it, or our list is stale). That's success, not failure:
       * pull the list and open it rather than showing the raw "chat already exists". */
      if (e && e.status === 409) {
        await refreshChats();
        const existing = isDm ? findDmWith(chosen[0].user_id) : null;
        if (existing) {
          closePicker();
          await selectChat(existing.chat_id);
          els.composerInput.focus();
        } else {
          els.newChatError.textContent = "You already have this conversation, but it isn't loading — try again.";
        }
      } else {
        els.newChatError.textContent = e.message || "Couldn't start the conversation.";
      }
    } finally {
      picker.busy = false;
      renderPickerMode();
    }
  }

  /* ---------- adding people to a group ----------
   * The 400 the server sends for a duplicate has the raw user id in it ("User 16 is
   * already a member of this chat!"), and it fires before anything is inserted -- the
   * endpoint checks every id first -- so the honest report names the person and says
   * nobody was added.
   */
  const DUP_MEMBER_RE = /^User (\d+) is already a member of this chat!$/;

  function addProblem(e, chosen) {
    const dup = e && typeof e.message === "string" ? DUP_MEMBER_RE.exec(e.message) : null;
    if (!dup) return friendly(e, "Couldn't add anyone to this group.");
    const who = chosen.find((u) => String(u.user_id) === dup[1]);
    const name = who ? (who.display_name || who.username) : "Someone";
    return name + " is already in this group — nobody was added.";
  }

  async function submitAddPeople() {
    if (picker.busy || !picker.selected.length) return;
    const chat = findChat(picker.chatId);
    if (!chat) { els.newChatError.textContent = "This group is no longer available."; return; }
    const chosen = picker.selected.slice();
    els.newChatError.textContent = "";
    picker.busy = true;
    renderPickerMode();
    try {
      await API.addMembers(chat.chat_id, chosen.map((u) => u.user_id));
      closePicker();
      /* Only the people we just added get a `member_added` frame -- we don't, and neither
       * do the other members -- so our own membership is the stale copy. GET /chats is the
       * only source of members and roles, so re-read it; that also re-renders the header
       * count and the group-details panel underneath. */
      await refreshChats();
      toast(chosen.length === 1
        ? (chosen[0].display_name || chosen[0].username) + " was added"
        : chosen.length + " people were added");
    } catch (e) {
      if (e && e.redirected) return;
      els.newChatError.textContent = addProblem(e, chosen);
      // A duplicate or a lost admin role both mean our copy of the group is behind.
      if (e && (e.status === 400 || e.status === 403)) refreshChats();
    } finally {
      picker.busy = false;
      renderPickerMode();
    }
  }

  /* ---------- conversation menu ----------
   * What the menu offers depends on the chat and on your role in it. In a group: everyone
   * gets "Members & roles" and "Leave group", an admin also gets "Add people" and "Delete
   * group". A DM has no admin at all and the server refuses to delete or leave one, so it
   * only offers "Delete for me", which hides it locally.
   */
  function renderChatMenu(chat) {
    closeChatMenu();
    if (!chat) { els.chatMenu.hidden = true; return; }
    const dm = isDm(chat);
    const admin = amAdmin(chat);
    els.menuMembers.hidden = dm;                        // a DM's two people are in the header already
    els.menuAddPeople.hidden = dm || !admin;            // the server refuses both cases anyway
    els.menuRename.hidden = dm || !admin;               // a DM's title comes from the other person
    els.menuLeave.hidden = dm;                          // any member can leave a group; nobody a DM
    els.menuDelete.hidden = !dm && !admin;              // only an admin can delete a group
    els.menuDelete.textContent = dm ? "Delete for me" : "Delete group";
    els.chatMenu.hidden = menuItems().length === 0;
  }

  function menuItems() {
    return [els.menuMembers, els.menuAddPeople, els.menuRename, els.menuLeave, els.menuDelete]
      .filter((b) => !b.hidden);
  }

  function openChatMenu() {
    els.chatMenuList.hidden = false;
    els.chatMenuBtn.setAttribute("aria-expanded", "true");
    const first = menuItems()[0];
    if (first) first.focus();
  }

  function closeChatMenu(refocus) {
    if (!els.chatMenuList || els.chatMenuList.hidden) return;
    els.chatMenuList.hidden = true;
    els.chatMenuBtn.setAttribute("aria-expanded", "false");
    if (refocus) els.chatMenuBtn.focus();
  }

  function toggleChatMenu() {
    if (els.chatMenuList.hidden) openChatMenu();
    else closeChatMenu(true);
  }

  function moveMenu(delta) {
    const items = menuItems();
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    const next = at < 0 ? (delta > 0 ? 0 : items.length - 1) : (at + delta + items.length) % items.length;
    items[next].focus();
  }

  /* ---------- confirmation dialog ----------
   * One dialog for both destructive menu items. `onOk` does the work and returns null on
   * success or a message on failure, so the dialog can stay open and explain itself.
   */
  function openConfirm({ title, copy, okLabel, onOk }) {
    confirmer.onOk = onOk;
    confirmer.busy = false;
    els.confirmTitle.textContent = title;
    els.confirmCopy.textContent = copy;
    els.confirmOk.textContent = okLabel;
    els.confirmError.textContent = "";
    els.confirmOk.disabled = false;
    els.confirmDialog.showModal();
    els.confirmOk.focus();
  }

  async function submitConfirm(ev) {
    ev.preventDefault();                       // method="dialog" would close before onOk ran
    if (confirmer.busy || !confirmer.onOk) return;
    confirmer.busy = true;
    els.confirmOk.disabled = true;
    els.confirmError.textContent = "";
    let problem = null;
    try {
      problem = await confirmer.onOk();
    } catch (e) {
      if (e && e.redirected) return;
      problem = (e && e.message) || "That didn't work.";
    } finally {
      confirmer.busy = false;
      els.confirmOk.disabled = false;
    }
    if (problem) { els.confirmError.textContent = problem; return; }
    if (els.confirmDialog.open) els.confirmDialog.close();
  }

  /* ---------- deleting a conversation ---------- */

  /* The server's 403 details are accurate but shouty, and the last-admin one is an
   * ordinary outcome rather than an error, so the ones a user can actually hit get
   * rewritten. Anything unmapped falls through to the detail text as-is. */
  /* The server's password rule, copied verbatim from `rgx` in app/routers/users.py: at
   * least 8 characters with a lowercase letter, an uppercase letter, a digit and a symbol,
   * and no whitespace anywhere. Mirrored, not owned -- the server re-checks it, this only
   * saves a round trip and lets the requirement be stated before you type. PW_HINT is the
   * one wording for it, used by the hint line, the local failure and the server's own 403. */
  const PW_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d])[^\s]{8,}$/;
  const PW_HINT = "Use at least 8 characters with an uppercase letter, a lowercase letter, " +
    "a number and a symbol, and no spaces.";

  const FRIENDLY = {
    "There must be at least one admin in the chat!":
      "A group needs at least one admin. Make someone else an admin first.",
    "You are not an admin of this chat!": "Only an admin can do that.",
    "You are not a member of this chat!": "You're not in this conversation any more.",
    "You can't delete a DM chat!": "Direct messages can't be deleted — hide it with “Delete for me” instead.",
    "You can't leave a DM chat!": "Direct messages can't be left — hide it with “Delete for me” instead.",
    "You can't add members to a DM!": "You can't add anyone to a direct message. Start a group instead.",
    // Kicking: an admin can only remove a plain member, so the two refusals are "demote
    // them first" and "you aren't an admin" -- both actionable, neither obvious from the
    // server's wording, which talks about kicking "a user" and "an admin" instead.
    "You can't kick an admin from the chat!": "Admins can't be removed. Demote them first, then remove them.",
    "You can't kick a user from the chat!": "Only an admin can remove people from a group.",
    "You can't kick someone from a DM chat!":
      "There's nobody to remove from a direct message — hide it with “Delete for me” instead.",
    /* The password endpoint's two refusals. "Missmatch" is the server's own spelling and the
     * key has to match it byte for byte or the rewrite silently won't fire; both are
     * normally caught locally first, so these are the backstop for a rule that drifts. */
    "Password Missmatch": "The new passwords don't match.",
    "Password does not meet the requirement": PW_HINT,
  };
  // The sole-admin 403 is shared by change_role and leave; leaving needs its own wording,
  // because "make someone else an admin" is the literal next step rather than a policy note.
  const NEED_ANOTHER_ADMIN = "There must be at least one admin in the chat!";
  function friendly(e, fallback) {
    return (e && FRIENDLY[e.message]) || (e && e.message) || fallback;
  }

  async function deleteGroup(chat) {
    deleting.add(chat.chat_id);
    try {
      await API.deleteChat(chat.chat_id);
      /* The chat_deleted frame normally does the cleanup (we get it too), but the socket
       * may be down or dead -- after a 200 the chat is gone either way, so clean up now.
       * dropChat() is idempotent, so whichever of the two arrives second does nothing. */
      dropChat(chat.chat_id);
      toast("Group deleted");
      return null;
    } catch (e) {
      if (e && e.redirected) return null;
      if (e && e.status === 404) { dropChat(chat.chat_id); return null; }   // already gone
      return friendly(e, "Couldn't delete this group.");
    } finally {
      deleting.delete(chat.chat_id);
    }
  }

  function hideDmLocally(chat) {
    hideDm(chat);
    // The chat still exists server-side, so dropChat() is wrong here -- but the info panel
    // is about a conversation that just left the list, so close it if it is the one showing.
    if (memberPanel.chatId === chat.chat_id && els.membersDialog.open) els.membersDialog.close();
    if (state.activeChatId === chat.chat_id) clearSelection();
    renderChatList();
    toast("Hidden on this device");
    return null;
  }

  // `chat` is passed when the info panel asks (its chat is the one on screen, not necessarily
  // the selected one by the time the confirmation resolves); the kebab omits it.
  function askDelete(chat) {
    chat = chat || findChat(state.activeChatId);
    if (!chat) return;
    const title = chatTitle(chat);
    if (isDm(chat)) {
      openConfirm({
        title: "Delete for me?",
        copy: "“" + title + "” leaves your list in this browser only. " +
          "The other person keeps the conversation, and it comes back here if they write again.",
        okLabel: "Delete for me",
        onOk: () => hideDmLocally(chat),
      });
      return;
    }
    if (!amAdmin(chat)) { toast("Only an admin can delete this group."); return; }
    openConfirm({
      title: "Delete this group?",
      copy: "“" + title + "” and every message in it are deleted for all " +
        (chat.members || []).length + " members. This can't be undone.",
      okLabel: "Delete group",
      onOk: () => deleteGroup(chat),
    });
  }

  /* ---------- leaving a group ---------- */

  async function leaveGroup(chat) {
    const title = chatTitle(chat);
    leaving.add(chat.chat_id);
    try {
      await API.leaveChat(chat.chat_id);
      /* The `member_removed` frame comes back to us and would do this, but the socket may
       * be down or dead and after a 200 we are out either way. dropChat() is idempotent,
       * so whichever of the two lands second does nothing -- and it closes the
       * group-details panel this was very likely launched from. */
      dropChat(chat.chat_id);
      toast("You left “" + title + "”");
      return null;
    } catch (e) {
      if (e && e.redirected) return null;
      if (e && e.message === NEED_ANOTHER_ADMIN) {
        return "You're the only admin. Make someone else an admin in “Members & roles” before you leave.";
      }
      // Already out (a second leave 403s the same way): finish the cleanup quietly.
      if (e && e.message === "You are not a member of this chat!") {
        dropChat(chat.chat_id);
        return null;
      }
      return friendly(e, "Couldn't leave this group.");
    } finally {
      leaving.delete(chat.chat_id);
    }
  }

  /* ---- rename a group ----
   * The new name is never applied here: a 200 only means it committed, and the
   * `chat_renamed` frame is what moves the sidebar, header and panel -- same rule as a
   * message, which renders on the echo rather than optimistically. So every open client,
   * this one included, updates from one place. */
  let renaming = null;

  function openRename(chat) {
    const target = chat || findChat(state.activeChatId);
    if (!target || isDm(target) || !amAdmin(target)) return;
    renaming = target.chat_id;
    els.renameError.textContent = "";
    els.renameInput.value = target.chat_name || "";
    els.renameSubmit.disabled = false;
    els.renameDialog.showModal();
    els.renameInput.focus();
    els.renameInput.select();
  }

  async function submitRename(ev) {
    ev.preventDefault();
    if (els.renameSubmit.disabled) return;
    const chat = findChat(renaming);
    if (!chat) { els.renameDialog.close(); return; }
    // The server takes any string, "" included, which would blank the group's name.
    const name = els.renameInput.value.trim();
    if (!name) {
      els.renameError.textContent = "Give the group a name.";
      els.renameInput.focus();
      return;
    }
    if (name === chat.chat_name) { els.renameDialog.close(); return; }   // nothing to do
    els.renameSubmit.disabled = true;
    els.renameError.textContent = "";
    try {
      await API.renameChat(chat.chat_id, name);
      els.renameDialog.close();
    } catch (e) {
      if (e && e.redirected) return;
      els.renameError.textContent = friendly(e) || "Couldn't rename the group.";
      els.renameSubmit.disabled = false;
      // A 403 usually means our copy of the roster or our own role is stale.
      if (e && e.status === 403) refreshChats();
    }
  }

  function askLeave(chat) {
    const target = chat || findChat(state.activeChatId);
    if (!target || isDm(target)) return;
    const title = chatTitle(target);
    // Pre-empt the sole-admin 403 with the same guidance, so the dead end is visible
    // before the click rather than after it.
    const copy = amSoleAdmin(target)
      ? "You're the only admin of “" + title + "”. Make someone else an admin first — " +
        "open “Members & roles”, promote them, then you can leave."
      : "You'll stop getting messages in “" + title + "” and it leaves your list. " +
        "An admin would have to add you back.";
    openConfirm({ title: "Leave this group?", copy, okLabel: "Leave group", onOk: () => leaveGroup(target) });
  }

  /* ---------- conversation info: members, roles, membership ----------
   * One panel for both kinds of conversation, reached two ways: the kebab's "Members &
   * roles" and the header's identity block. The names here still say `members` -- the panel
   * grew into the DM case rather than being replaced, and renaming nine ids plus every
   * reference would be churn with no behaviour behind it.
   *
   * There is no members endpoint: GET /chats is the only source of `role` and of the
   * roster itself, so every successful change_role / add_member / leave is followed by
   * refreshChats(), which calls renderMembers() again while this panel is open.
   *
   * A GROUP gets the roster grouped by role instead of a tag on every row, which is what
   * made the old flat list noisy: with "Admins" and "Members" as headings, a row only has to
   * say who it is. The actions are deliberately unequal -- "Make admin" is an outlined chip
   * you reach for, while "Demote"/"Step down" is quiet text that only turns red under the
   * cursor -- so the significant action no longer looks like the benign one. An admin also
   * gets "Rename" in the head, beside the name it changes.
   *
   * A DM gets the same frame with everything role-shaped removed, because a DM has no admin
   * (both members are role "user") and the server refuses to rename, delete or leave one:
   * one flat two-person list, no row actions, no Add people, no Leave, and "Delete for me"
   * as the only destructive action -- which is a purely local hide, not a server call.
   */
  function openMembers() {
    const chat = findChat(state.activeChatId);
    if (!chat) return;
    memberPanel.chatId = chat.chat_id;
    memberPanel.busy = null;
    els.membersError.textContent = "";
    renderMembers();
    if (!els.membersDialog.open) els.membersDialog.showModal();
    // Land focus on something non-destructive: the primary action if there is one,
    // otherwise Close. Never Leave or Delete, which <dialog> would pick on its own.
    (els.membersAdd.hidden ? els.membersClose : els.membersAdd).focus();
  }

  function memberRow(chat, m, iAmAdmin) {
    const self = !!state.me && m.user_id === state.me.user_id;
    const isAdminRow = m.role === "admin";
    const name = m.display_name || "Someone";
    const saving = memberPanel.busy === m.user_id;
    /* Every admin row keeps its control even when this client thinks it is the last admin
     * (our roles can be stale, and the server is the judge): the confirmation says so up
     * front instead, and the 403 is rewritten if it still lands. */
    const actions = [];
    if (iAmAdmin) {
      // The visible label is short by design, so the accessible name says who it is about.
      const label = self && isAdminRow ? "Step down as admin"
        : isAdminRow ? "Demote " + name + " to member"
          : "Make " + name + " an admin";
      actions.push(el("button", {
        type: "button",
        class: "row-action" + (isAdminRow ? " caution" : ""),
        "aria-label": label,
        disabled: memberPanel.busy !== null,
        onclick: () => (self && isAdminRow
          ? askStepDown(chat, m)
          : applyRole(m.user_id, isAdminRow ? "user" : "admin")),
      }, saving ? "Saving…" : self && isAdminRow ? "Step down" : isAdminRow ? "Demote" : "Make admin"));
    }
    /* "Remove" exactly where the server will accept it: an admin, in a group, on a plain
     * member who isn't you. The backend refuses an admin target (demote them first) and
     * has no self-kick, so your own row keeps "Leave group" in the footer as the way out.
     * Quiet .caution weight, never the outlined one -- removing somebody must not read
     * like the benign "Make admin" beside it. */
    if (iAmAdmin && !isAdminRow && !self && !isDm(chat)) {
      actions.push(el("button", {
        type: "button",
        class: "row-action caution",
        "aria-label": "Remove " + name + " from this group",
        disabled: memberPanel.busy !== null,
        onclick: () => askRemoveMember(chat, m),
      }, "Remove"));
    }
    return el("li", { class: "roster-row" + (saving ? " saving" : "") },
      avatarEl(name, "user:" + m.user_id, m.avatar_url),
      el("span", { class: "roster-main" },
        el("span", { class: "roster-name" }, name),
        self ? el("span", { class: "roster-you" }, "You") : null),
      actions.length ? el("span", { class: "roster-actions" }, actions) : null);
  }

  // `caption` is null for a DM: two people with no roles between them need no heading, and
  // "Members 2" over a list of exactly you and them reads like a group.
  function rosterGroup(chat, caption, people, iAmAdmin) {
    if (!people.length) return null;
    return el("section", { class: "roster-group" },
      caption ? el("h3", { class: "roster-cap" },
        el("span", null, caption),
        el("span", { class: "roster-count" }, String(people.length))) : null,
      el("ul", { class: "roster-list", role: "list" },
        people.map((m) => memberRow(chat, m, iAmAdmin))));
  }

  function renderMembers() {
    const chat = findChat(memberPanel.chatId);
    els.memberList.replaceChildren();
    els.membersFace.replaceChildren();
    if (!chat) {
      els.membersTitle.textContent = "Members";
      els.membersSub.textContent = "";
      els.membersStatus.textContent = "This conversation is no longer available.";
      els.membersAdd.hidden = true;
      els.membersLeave.hidden = true;
      els.membersRename.hidden = true;
      els.membersDelete.hidden = true;
      return;
    }

    const title = chatTitle(chat);
    const dm = isDm(chat);
    const members = (chat.members || []).slice();
    const admins = adminCount(chat);
    const iAmAdmin = amAdmin(chat);
    const byName = (a, b) =>
      String(a.display_name || "").localeCompare(String(b.display_name || ""));

    els.membersTitle.textContent = title;
    // A DM's avatar is hued by the other person, like its sidebar row and header, and can
    // carry their picture; a group's tile is hued by chat_id and has no image.
    const other = dm ? otherMember(chat) : null;
    els.membersFace.append(
      avatarEl(title, chatAvatarSeed(chat), other && other.avatar_url, "avatar-lg"));
    els.memberList.setAttribute("aria-busy", memberPanel.busy !== null ? "true" : "false");

    if (dm) {
      els.membersSub.textContent = "Direct message";
      els.membersStatus.textContent =
        "Just the two of you. A direct message has no admin, can't be renamed, and can't be " +
        "deleted for both of you — “Delete for me” only clears it from this browser.";
      els.membersAdd.hidden = true;        // the server refuses add_member on a DM
      els.membersLeave.hidden = true;      // ...and leave, and delete_chat
      els.membersRename.hidden = true;     // ...and rename
      els.membersDelete.hidden = false;    // the local hide is the only thing left
      // No role sections and no row actions: memberRow() draws none once iAmAdmin is false.
      const flat = rosterGroup(chat, null, members.sort(byName), false);
      els.memberList.append(flat || el("p", { class: "roster-empty" }, "Nobody is in this conversation."));
      return;
    }

    els.membersSub.textContent =
      members.length + (members.length === 1 ? " member" : " members") +
      " · " + admins + (admins === 1 ? " admin" : " admins");
    els.membersStatus.textContent = iAmAdmin
      ? (admins === 1
        ? "You're the only admin. Make someone else one before you step down or leave."
        : "You're an admin: you can add or remove people and change who else is an admin.")
      : "Only an admin can add or remove people, or change roles.";
    els.membersAdd.hidden = !iAmAdmin;
    els.membersLeave.hidden = false;
    els.membersRename.hidden = !iAmAdmin;  // same gate the endpoint enforces
    els.membersDelete.hidden = true;        // a group is deleted from the kebab, for everyone

    // By name inside each group; the groups themselves put the people who can act first.
    const groups = [
      rosterGroup(chat, "Admins", members.filter((m) => m.role === "admin").sort(byName), iAmAdmin),
      rosterGroup(chat, "Members", members.filter((m) => m.role !== "admin").sort(byName), iAmAdmin),
    ].filter(Boolean);
    if (!groups.length) {
      els.memberList.append(el("p", { class: "roster-empty" }, "Nobody is in this group."));
      return;
    }
    els.memberList.append(...groups);
  }

  /* Giving up your own admin rights is one click you can't take back yourself, so it goes
   * through the same confirmation as a delete -- and it opens on top of this panel, which
   * stays underneath. A sole admin is warned before the click; the server refuses it, and
   * applyRole() rewrites that 403 if they go ahead anyway. */
  function askStepDown(chat, member) {
    openConfirm({
      title: "Step down as admin?",
      copy: amSoleAdmin(chat)
        ? "You're the only admin of this group, so this won't go through until someone " +
          "else is one. Make another member an admin first, then step down."
        : "You'll become a regular member of this group and won't be able to delete it " +
          "or change roles. Another admin would have to make you one again.",
      okLabel: "Step down",
      onOk: () => applyRole(member.user_id, "user"),
    });
  }

  /* ---------- removing a member ----------
   * POST /chat/{chat_id}/kick is admin-only and plain-member-only, so the button is only
   * drawn where it can succeed (see memberRow) -- but roles here are only ever as fresh as
   * the last GET /chats, so the server is still the judge and its 403s are rewritten
   * through FRIENDLY if one lands anyway.
   *
   * It is the one row action that does something irreversible to somebody else, so it goes
   * through the shared confirmation like "Step down" and "Leave group", opening on top of
   * the panel, which stays underneath.
   *
   * Nothing is drawn locally: the kicked member gets a `member_removed` frame (the
   * existing handler drops the chat for them) and everyone still in the chat gets a
   * `member_kicked` system frame that puts the event line in the timeline. We get neither,
   * so the refresh below is what updates our own roster.
   */
  function askRemoveMember(chat, member) {
    const name = member.display_name || "this person";
    openConfirm({
      title: "Remove " + name + "?",
      copy: name + " leaves “" + chatTitle(chat) + "” and stops receiving its messages. " +
        "Everyone in the group sees that you removed them, and an admin can add them back.",
      okLabel: "Remove",
      onOk: () => kickMember(chat, member),
    });
  }

  // Returns null on success, or the message to show — same contract as applyRole().
  async function kickMember(chat, member) {
    if (memberPanel.busy !== null) return null;
    memberPanel.busy = member.user_id;
    els.membersError.textContent = "";
    renderMembers();
    const name = member.display_name || "They";
    try {
      await API.kickMember(chat.chat_id, member.user_id);
      memberPanel.busy = null;
      await refreshChats();            // the only source of the roster; re-renders this panel
      toast(name + " was removed");
      return null;
    } catch (e) {
      memberPanel.busy = null;
      if (e && e.redirected) return null;
      // 404 "User not found in this chat": they are already out and our roster was behind.
      if (e && e.status === 404) {
        await refreshChats();
        return null;
      }
      const problem = friendly(e, "Couldn't remove them from this group.");
      els.membersError.textContent = problem;
      renderMembers();
      return problem;
    }
  }

  // Returns null on success, or the message to show — so openConfirm() can use it too.
  async function applyRole(userId, newRole) {
    const chat = findChat(memberPanel.chatId);
    if (!chat || memberPanel.busy !== null) return null;
    memberPanel.busy = userId;
    els.membersError.textContent = "";
    renderMembers();
    try {
      await API.changeRole(chat.chat_id, userId, newRole);
      memberPanel.busy = null;
      await refreshChats();              // the only place roles come from; re-renders the list
      return null;
    } catch (e) {
      memberPanel.busy = null;
      if (e && e.redirected) return null;
      const problem = friendly(e, "Couldn't change that role.");
      els.membersError.textContent = problem;
      renderMembers();
      return problem;
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
    els.meBtn.addEventListener("click", openProfile);
    els.profileLogout.addEventListener("click", logout);
    els.profilePassword.addEventListener("click", openPassword);
    els.passwordForm.addEventListener("submit", submitPassword);
    /* Cancel, Esc and a successful change all end up here, so the typed password never
     * outlives the dialog in the DOM. */
    els.passwordDialog.addEventListener("close", clearPasswordFields);
    els.newChatBtn.addEventListener("click", openNewChat);
    /* A second way into the info card, beside the kebab's "Members & roles" -- and the only
     * way in for a DM, which has no menu item for it. The kebab is untouched. */
    els.chatInfoBtn.addEventListener("click", openMembers);
    els.newChatForm.addEventListener("submit", submitPicker);
    // Every dialog's Cancel/Close button just closes its own dialog; per-dialog "close"
    // listeners below do the tidying up, so Esc and the button behave identically.
    for (const b of document.querySelectorAll("dialog [data-close]")) {
      b.addEventListener("click", () => {
        const d = b.closest("dialog");
        if (d && d.open) d.close();
      });
    }
    // Esc closes the dialog natively; make sure the in-flight search dies with it and the
    // picker falls back to its default flow.
    els.newChatDialog.addEventListener("close", () => {
      cancelSearch();
      picker.mode = "new";
      picker.chatId = null;
    });

    els.chatMenuBtn.addEventListener("click", toggleChatMenu);
    els.chatMenuList.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); closeChatMenu(true); }
      else if (ev.key === "ArrowDown") { ev.preventDefault(); moveMenu(1); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); moveMenu(-1); }
    });
    // A click anywhere else dismisses the menu (the trigger handles its own toggle).
    document.addEventListener("click", (ev) => {
      if (!els.chatMenu.contains(ev.target)) closeChatMenu();
    });
    els.menuMembers.addEventListener("click", () => { closeChatMenu(); openMembers(); });
    els.menuAddPeople.addEventListener("click", () => { closeChatMenu(); openAddPeople(); });
    els.menuRename.addEventListener("click", () => { closeChatMenu(); openRename(); });
    els.renameForm.addEventListener("submit", submitRename);
    els.menuLeave.addEventListener("click", () => { closeChatMenu(); askLeave(); });
    els.menuDelete.addEventListener("click", () => { closeChatMenu(); askDelete(); });

    // Every panel action opens a second dialog on top of this one, which stays put.
    els.membersAdd.addEventListener("click", () => openAddPeople(findChat(memberPanel.chatId)));
    els.membersLeave.addEventListener("click", () => askLeave(findChat(memberPanel.chatId)));
    els.membersRename.addEventListener("click", () => openRename(findChat(memberPanel.chatId)));
    // DM-only: the local hide, never a server delete -- the server refuses to delete a DM.
    els.membersDelete.addEventListener("click", () => askDelete(findChat(memberPanel.chatId)));
    els.membersDialog.addEventListener("close", () => { memberPanel.chatId = null; memberPanel.busy = null; });
    els.confirmForm.addEventListener("submit", submitConfirm);
    els.confirmDialog.addEventListener("close", () => {
      confirmer.onOk = null;
      confirmer.busy = false;
      // The control we came from may have been deleted along with the chat; park focus
      // somewhere real rather than letting it fall back to <body>.
      if (!state.activeChatId && !els.membersDialog.open) els.newChatBtn.focus();
    });

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

    els.composerInput.addEventListener("input", () => {
      autoGrow();
      updateComposer();
      maybeSendTyping();        // throttled to one frame every TYPING_SEND_MS, not per keystroke
    });
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

    // The composer floats over the messages, so the scroll box needs to reserve
    // exactly its height -- which changes as the textarea grows.
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        document.documentElement.style.setProperty("--composer-h", els.composer.offsetHeight + "px");
      }).observe(els.composer);
    }

    window.addEventListener("online", () => WS.connect());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") WS.connect();
    });
  }

  /* ---------- boot ---------- */
  async function boot() {
    document.body.dataset.view = "list";
    state.hiddenDms = loadHiddenDms();
    try {
      state.me = await API.getMe();
    } catch (e) {
      if (e.status === 401) { API.toLogin(); return; }
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
      // A hidden DM that has moved on since it was hidden comes straight back.
      for (const id of Object.keys(state.hiddenDms)) {
        const c = state.chats.find((x) => x.chat_id === id);
        if (!c || newsSinceHidden(c)) unhideDm(id);
      }
      sortChats();
    } catch (e) {
      if (e.redirected) return;
      toast(e.message || "Couldn't load chats");
    }
    renderChatList();
    showChatPane(false);
    updateConnBanner();
    WS.connect();

    const first = visibleChats()[0];
    if (first && DESKTOP.matches) selectChat(first.chat_id);
  }

  boot();
})();
