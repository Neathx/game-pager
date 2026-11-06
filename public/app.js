"use strict";

// Quick-pick times for "I'm on at" (24-hour clock). Change these to suit your schedule.
const TIMES = ["19:00", "19:30", "20:00", "20:30", "21:00"];
const LATE = [10, 15, 30];

const app = document.getElementById("app");
const toastEl = document.getElementById("toast");

// Three looks, picked per phone in Settings → Look.
const THEMES = [
  { id: "retro", label: "Retro", color: "#2b2d2f" },
  { id: "military", label: "Military", color: "#16180f" },
  { id: "minimal", label: "Minimal", color: "#f7f7f8" },
];
function currentTheme() {
  const t = document.body.dataset.theme;
  return THEMES.some((x) => x.id === t) ? t : "retro";
}
function applyTheme(id) {
  const t = THEMES.find((x) => x.id === id) || THEMES[0];
  document.body.dataset.theme = t.id;
  document.documentElement.style.background = t.color;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.color);
  try { localStorage.setItem("pager-theme", t.id); } catch {}
}
applyTheme(currentTheme());

let cfg = load(); // { slot, code, name, vapidKey }
let state = null;
let ui = { custom: false, late: false, busy: false, settingsOpen: false };
let alertsOn = false;

function load() {
  try {
    const c = JSON.parse(localStorage.getItem("pager") || "null");
    return c && c.slot ? c : null;
  } catch {
    return null;
  }
}
function saveCfg(c) {
  cfg = c;
  if (c) localStorage.setItem("pager", JSON.stringify(c));
  else localStorage.removeItem("pager");
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastEl.classList.remove("show"), 2400);
}
function buzz() { if (navigator.vibrate) navigator.vibrate(15); }

async function api(path, body, auth = cfg) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", "x-pair-code": auth?.code || "", "x-user": auth?.slot || "" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `Server error (${res.status})` }));
  if (!res.ok) {
    const e = new Error(data.error || `Error ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

// ---------- formatting ----------
function short(hhmm) {
  let [h, m] = hhmm.split(":").map(Number);
  const ap = h >= 12 ? "P" : "A";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")}${ap}`;
}
function dateLabel(iso) {
  const d = new Date(iso + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "2-digit", timeZone: "UTC" }).replace(",", "").toUpperCase();
}
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "NOW";
  if (m < 60) return `${m}M AGO`;
  return `${Math.floor(m / 60)}H AGO`;
}
function statusText(p) {
  if (!p) return "--";
  if (p.onlineAt) return "ONLINE NOW";
  if (p.status === "yes") return p.time ? `IN @ ${short(p.time)}${p.lateBy ? " +" + p.lateBy : ""}` : "IN";
  if (p.status === "maybe") return "MAYBE";
  if (p.status === "no") return "OUT";
  return "--";
}
const otherSlot = () => (cfg.slot === "p1" ? "p2" : "p1");

// ---------- pairing screen ----------
function renderSetup(error = "") {
  app.innerHTML = `
  <div class="top"><div class="logo">GAME·PAGER</div></div>
  <div class="lcd">
    <div class="row">PAIR THIS PHONE</div>
    <div class="rule"></div>
    <div class="row small">ENTER YOUR NAME AND</div>
    <div class="row small">YOUR PAGER'S PAIR CODE.</div>
  </div>
  <form class="setup group" id="pairForm">
    <label class="label" for="name">YOUR NAME</label>
    <input id="name" type="text" class="name" autocomplete="nickname" spellcheck="false" maxlength="16" required placeholder="e.g. your gamertag">
    <label class="label" for="code" style="margin-top:18px">PAIR CODE</label>
    <input id="code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="32" required>
    <p class="err" id="err">${esc(error)}</p>
    <button class="page" type="submit">PAIR</button>
    <p class="note">First time? Type any name you like. Your friend does the same with the same pair code. Already paired on another phone? Use the same name to sign back in.</p>
  </form>`;
  document.getElementById("pairForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("name").value.trim();
    const code = document.getElementById("code").value.trim().toUpperCase();
    const err = document.getElementById("err");
    try {
      const r = await api("/api/pair", { name }, { code });
      saveCfg({ slot: r.slot, code, name: r.name, vapidKey: r.vapidKey });
      await start();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
}

// ---------- main screen ----------
function render() {
  if (!state) {
    app.innerHTML = `<div class="top"><div class="logo">GAME·PAGER</div></div><div class="lcd"><div class="row">CONNECTING...</div></div>`;
    return;
  }
  const me = cfg.slot;
  const other = otherSlot();
  const N = state.names;
  const otherName = N[other];
  const mine = state.players[me];
  const feed = state.feed.slice(-2).reverse();
  const customTime = mine.time && !TIMES.includes(mine.time) ? mine.time : null;

  let alertChip;
  if (alertsOn) alertChip = `<span class="chip"><span class="dot" aria-hidden="true"></span>Alerts on</span>`;
  else if (pushSupported && (!isIOS || standalone)) alertChip = `<button class="chip off" data-act="alerts">TURN ON ALERTS</button>`;
  else alertChip = `<span class="chip">Alerts off</span>`;

  let banner = "";
  if (isIOS && !standalone) {
    banner = `<p class="warn">To get alerts on iPhone: tap the Share button, then <b>Add to Home Screen</b>, and open Pager from your home screen.</p>`;
  } else if (!pushSupported) {
    banner = `<p class="warn">This browser can't show alerts. On Android use Chrome; on iPhone add the app to your home screen.</p>`;
  }

  let friendNote = "";
  if (!otherName) {
    friendNote = `<p class="note">Waiting for your friend to pair. Send them this app's link and the pair code.</p>`;
  } else if (state.devices[other] === 0) {
    friendNote = `<p class="note">${esc(otherName)} hasn't turned on alerts yet, so pages won't buzz their phone.</p>`;
  }

  // Optional PUBG stats card
  let statsCard = "";
  if (state.statsEnabled) {
    const ls = state.lastSession;
    let body;
    if (ls) {
      const d = ls.wins === 1 ? "dinner" : "dinners";
      const who = Object.values(ls.players)
        .filter((q) => q.games)
        .map((q) => `<span>${esc(q.name.toUpperCase())}: ${q.kills} kills · ${q.damage} dmg · best ${q.bestKills}</span>`)
        .join("");
      body = `
        <div class="head"><span>LAST SESSION · ${dateLabel(ls.date)}</span><span>PUBG</span></div>
        <div class="nums">
          <div><b>${ls.games}</b><span>games</span></div>
          <div><b>${ls.wins}</b><span>${d}</span></div>
          <div><b>${ls.kills}</b><span>kills</span></div>
          <div><b>${ls.top10}</b><span>top 10</span></div>
        </div>
        <div class="who">${who}</div>`;
    } else if (!state.pubg[me]) {
      body = `<div class="head"><span>LAST SESSION</span><span>PUBG</span></div>
        <p class="empty">Add your PUBG name in Settings to get stats the morning after you play.</p>`;
    } else {
      body = `<div class="head"><span>LAST SESSION</span><span>PUBG</span></div>
        <p class="empty">Stats show up here the morning after you play.</p>`;
    }
    if (state.lastStatsRun && !state.lastStatsRun.ok) {
      body += `<p class="empty">Last stats check failed: ${esc(state.lastStatsRun.error)}</p>`;
    } else if (state.lastStatsRun?.missing?.length) {
      body += `<p class="empty">PUBG couldn't find: ${esc(state.lastStatsRun.missing.join(", "))}. Names must match exactly.</p>`;
    }
    statsCard = `<section class="stats" aria-label="Last session stats">${body}</section>`;
  }

  app.innerHTML = `
  <div class="top"><div class="logo">GAME·PAGER</div>${alertChip}</div>
  ${banner}
  <section class="lcd" aria-label="Tonight">
    <div class="row small"><span>${dateLabel(state.date)}</span><span>TONIGHT</span></div>
    <div class="rule"></div>
    <div class="row"><span>${esc(N[me].toUpperCase())}</span><span>${statusText(state.players[me])}</span></div>
    <div class="row"><span>${otherName ? esc(otherName.toUpperCase()) : "FRIEND"}</span><span>${otherName ? statusText(state.players[other]) : "NOT PAIRED"}</span></div>
    ${feed.map((f, i) => `<div class="msg${i ? " old" : ""}">${esc(f.text.toUpperCase())} · ${ago(f.at)}</div>`).join("")}
  </section>

  <button class="page" data-act="ask">PAGE: YOU ON TONIGHT?</button>

  <div class="group">
    <div class="label">MY ANSWER</div>
    <div class="grid3">
      <button class="key" data-act="reply" data-v="yes" aria-pressed="${mine.status === "yes"}">In</button>
      <button class="key" data-act="reply" data-v="maybe" aria-pressed="${mine.status === "maybe"}">Maybe</button>
      <button class="key" data-act="reply" data-v="no" aria-pressed="${mine.status === "no"}">Out</button>
    </div>
  </div>

  <div class="group">
    <div class="label">I'M ON AT</div>
    <div class="grid3">
      ${TIMES.map((t) => `<button class="key" data-act="time" data-v="${t}" aria-pressed="${mine.time === t}">${short(t)}</button>`).join("")}
      <button class="key" data-act="custom" aria-pressed="${!!customTime}" aria-expanded="${ui.custom}">${customTime ? short(customTime) : "Custom"}</button>
    </div>
    ${ui.custom ? `
    <div class="panel">
      <input type="time" id="customTime" aria-label="Custom time" value="${customTime || "20:00"}">
      <button class="key" data-act="setCustom">SET</button>
    </div>` : ""}
  </div>

  <div class="group">
    <div class="grid2">
      <button class="big" data-act="lateMenu" aria-expanded="${ui.late}">Running late</button>
      <button class="big now" data-act="now">HOPPING ON NOW</button>
    </div>
    ${ui.late ? `<div class="panel">${LATE.map((m) => `<button class="key" data-act="late" data-v="${m}">+${m} min</button>`).join("")}</div>` : ""}
  </div>

  ${friendNote}
  ${statsCard}

  <details id="settings" ${ui.settingsOpen ? "open" : ""}>
    <summary>SETTINGS</summary>
    <div class="group settings-group">
      <div class="label">LOOK</div>
      <div class="toggle three" role="group" aria-label="App look">
        ${THEMES.map((t) => `<button data-act="theme" data-v="${t.id}" aria-pressed="${currentTheme() === t.id}">${t.label}</button>`).join("")}
      </div>
    </div>
    <form class="field" data-form="name">
      <label class="label" for="myName">MY NAME</label>
      <div class="panel">
        <input id="myName" type="text" maxlength="16" value="${esc(N[me])}" spellcheck="false">
        <button class="key" type="submit">SAVE</button>
      </div>
    </form>
    ${state.statsEnabled ? `
    <form class="field" data-form="pubg">
      <label class="label" for="myPubg">MY PUBG NAME (STEAM, EXACT SPELLING)</label>
      <div class="panel">
        <input id="myPubg" type="text" maxlength="24" value="${esc(state.pubg[me] || "")}" spellcheck="false" autocapitalize="off">
        <button class="key" type="submit">SAVE</button>
      </div>
    </form>` : ""}
    <div class="grid2">
      <button class="key" data-act="test">Send me a test alert</button>
      ${state.statsEnabled ? `<button class="key" data-act="stats">Check stats now</button>` : ""}
      ${!alertsOn && pushSupported ? `<button class="key" data-act="alerts">Turn on alerts</button>` : ""}
      <button class="key" data-act="unpair">Unpair this phone</button>
      <button class="key danger" data-act="reset">Reset pager</button>
    </div>
    <p class="note">Unpair signs this phone out; your name stays on the pager. Reset clears both names and all alerts so you can start over.</p>
  </details>`;
}

// ---------- actions ----------
async function act(type, value) {
  if (ui.busy) return;
  ui.busy = true;
  buzz();
  try {
    const r = await api("/api/action", { type, value });
    state = r;
    ui.custom = false;
    ui.late = false;
    render();
    const other = state.names[otherSlot()];
    if (r.delivered) toast("PAGE SENT");
    else if (!other) toast("SAVED · FRIEND NOT PAIRED YET");
    else toast(`SAVED · ${other.toUpperCase()} HAS NO ALERTS`);
  } catch (e) {
    handleError(e);
  } finally {
    ui.busy = false;
  }
}

async function unpairThisPhone() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await api("/api/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch {}
  saveCfg(null);
  state = null;
  alertsOn = false;
  renderSetup();
}

app.addEventListener("toggle", (e) => {
  if (e.target.id === "settings") ui.settingsOpen = e.target.open;
}, true);

app.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-form]");
  if (!f) return;
  e.preventDefault();
  try {
    if (f.dataset.form === "name") {
      state = await api("/api/profile", { name: document.getElementById("myName").value });
      saveCfg({ ...cfg, name: state.names[cfg.slot] });
      toast("NAME SAVED");
    } else {
      state = await api("/api/profile", { pubg: document.getElementById("myPubg").value });
      toast("PUBG NAME SAVED");
    }
    render();
  } catch (err) {
    if (err.status === 400) toast(err.message.toUpperCase());
    else handleError(err);
  }
});

app.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b || !cfg) return;
  const v = b.dataset.v;
  switch (b.dataset.act) {
    case "ask": return act("ask");
    case "reply": return act("reply", v);
    case "time": return act("time", v);
    case "now": return act("now");
    case "late": return act("late", v);
    case "custom": ui.custom = !ui.custom; ui.late = false; render(); document.getElementById("customTime")?.focus(); return;
    case "setCustom": {
      const t = document.getElementById("customTime").value;
      if (t) return act("time", t);
      return;
    }
    case "theme": applyTheme(v); buzz(); return render();
    case "lateMenu": ui.late = !ui.late; ui.custom = false; return render();
    case "alerts": return enableAlerts(true);
    case "test":
      try {
        const r = await api("/api/test-push", {});
        toast(r.delivered ? "TEST SENT" : "ALERTS AREN'T ON FOR THIS PHONE");
      } catch (err) { handleError(err); }
      return;
    case "stats":
      toast("CHECKING PUBG...");
      try {
        const r = await api("/api/stats/refresh", { hours: 24 });
        if (r.error) toast(r.error.toUpperCase());
        else toast(r.games ? `${r.games} GAMES FOUND` : "NO GAMES IN LAST 24H");
        await refresh();
      } catch (err) { handleError(err); }
      return;
    case "unpair":
      return unpairThisPhone();
    case "reset":
      if (!confirm("Reset the pager? This clears both names and turns off alerts on both phones. You'll both need to pair again.")) return;
      try {
        await api("/api/reset", { confirm: "RESET" });
      } catch (err) { return handleError(err); }
      return unpairThisPhone();
  }
});

function handleError(e) {
  if (e.status === 401) {
    saveCfg(null);
    return renderSetup(e.message);
  }
  toast(e.status === 503 ? "SERVER NOT SET UP" : "NO SIGNAL · TRY AGAIN");
  console.error(e);
}

// ---------- push ----------
function keyBytes(b64) {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64.length / 4) * 4, "="));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function enableAlerts(ask) {
  if (!pushSupported) return;
  try {
    if (Notification.permission !== "granted") {
      if (!ask) return;
      const p = await Notification.requestPermission();
      if (p !== "granted") {
        toast("ALERTS BLOCKED");
        return;
      }
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(cfg.vapidKey) });
    }
    await api("/api/subscribe", { subscription: sub.toJSON() });
    alertsOn = true;
    if (ask) toast("ALERTS ON");
    await refresh();
  } catch (e) {
    // The server's keys changed since this phone subscribed: start fresh.
    if (e.name === "InvalidStateError") {
      const reg = await navigator.serviceWorker.ready;
      await (await reg.pushManager.getSubscription())?.unsubscribe();
      return enableAlerts(ask);
    }
    if (e.status) return handleError(e);
    console.error(e);
    if (ask) toast("COULDN'T TURN ON ALERTS");
  }
}

// ---------- startup ----------
async function refresh() {
  if (!cfg) return;
  try {
    state = await api("/api/state");
    render();
  } catch (e) {
    handleError(e);
  }
}

async function start() {
  render();
  await refresh();
  if (pushSupported && Notification.permission === "granted") enableAlerts(false);
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
  navigator.serviceWorker.addEventListener("message", (e) => { if (e.data === "refresh") refresh(); });
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
setInterval(() => {
  const typing = document.activeElement && ["INPUT", "SELECT"].includes(document.activeElement.tagName);
  if (!document.hidden && !ui.custom && !typing) refresh();
}, 20000);

if (cfg) start();
else renderSetup();
