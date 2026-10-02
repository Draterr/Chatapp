/* login.js — POST /api/login and /api/register; branch on HTTP status, not message text. */
(() => {
  "use strict";

  const form = document.getElementById("authForm");
  const error = document.getElementById("error");
  const submitBtn = document.getElementById("submitBtn");
  const tabs = [document.getElementById("tabLogin"), document.getElementById("tabRegister")];
  const passwordInput = form.elements.password;
  let mode = "login";

  // Already signed in? Skip the form.
  fetch("/api/me", { credentials: "include" })
    .then((r) => { if (r.ok) location.replace("/"); })
    .catch(() => { /* server unreachable: stay on the page */ });

  function setMode(next) {
    mode = next;
    for (const t of tabs) {
      const on = t.dataset.mode === mode;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", String(on));
    }
    submitBtn.textContent = mode === "login" ? "Sign in" : "Create account";
    passwordInput.autocomplete = mode === "login" ? "current-password" : "new-password";
    error.textContent = "";
  }
  for (const t of tabs) t.addEventListener("click", () => setMode(t.dataset.mode));

  function post(path, body) {
    return fetch("/api" + path, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function detailOf(res, fallback) {
    try {
      const j = await res.json();
      if (j && typeof j.detail === "string") return j.detail;
    } catch (_) { /* no JSON body */ }
    return fallback;
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const username = form.elements.username.value.trim();
    const password = form.elements.password.value;
    error.textContent = "";

    if (!username) { error.textContent = "Enter a username."; return; }
    if (!password) { error.textContent = "Enter a password."; return; }

    submitBtn.disabled = true;
    try {
      if (mode === "register") {
        const reg = await post("/register", { username, password });
        if (reg.status === 400) { error.textContent = await detailOf(reg, "Couldn't create the account."); return; }
        if (!reg.ok) { error.textContent = "Something went wrong. Please try again."; return; }
        // Account created — fall through and sign in with the same credentials.
      }

      const res = await post("/login", { username, password });
      if (res.ok) { location.replace("/"); return; }
      if (res.status === 401) { error.textContent = "Incorrect username or password."; return; }
      if (res.status === 400) { error.textContent = await detailOf(res, "Invalid username or password."); return; }
      error.textContent = "Something went wrong. Please try again.";
    } catch (_) {
      error.textContent = "Can't reach the server. Check that the backend is running.";
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
