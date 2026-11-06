import { DurableObject } from "cloudflare:workers";
import { sendPush, vapidPublicKey } from "./webpush.js";
import { collectSession } from "./pubg.js";

// The pager has two spots. Each friend claims one by typing their name when they pair.
const SLOTS = ["p1", "p2"];
const otherOf = (slot) => (slot === "p1" ? "p2" : "p1");

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const pager = (env) => env.PAGER.get(env.PAGER.idFromName("main"));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return pager(env).fetch(request);
    return env.ASSETS.fetch(request);
  },
  // Daily stats check (only does anything if a PUBG API key is set up).
  async scheduled(event, env, ctx) {
    if (env.PUBG_API_KEY) ctx.waitUntil(pager(env).runStats({ hours: 24, notify: true }));
  },
};

// "Tonight" rolls over at 5 AM local time, so a late session still counts as the same night.
function sessionDate(tz, now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now - 5 * 3600e3));
}

function fmt12(hhmm) {
  let [h, m] = hhmm.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ap}`;
}

function addMin(hhmm, mins) {
  const [h, m] = hhmm.split(":").map(Number);
  const t = (h * 60 + m + mins) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

// Names: 1-16 letters, numbers, spaces, dots, dashes or underscores.
function cleanName(v) {
  const s = String(v ?? "").trim().replace(/\s+/g, " ");
  return /^[\p{L}\p{N} ._-]{1,16}$/u.test(s) ? s : null;
}
function cleanPubg(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return /^[A-Za-z0-9_-]{3,24}$/.test(s) ? s : null;
}

const blankPlayer = () => ({ status: null, time: null, lateBy: 0, onlineAt: null });
const emptySlots = (v) => Object.fromEntries(SLOTS.map((k) => [k, v]));

export class PagerStore extends DurableObject {
  async load() {
    const s = (await this.ctx.storage.get("state")) || {};
    s.names ||= emptySlots(null);
    s.pubg ||= emptySlots(null);
    s.lastSession ??= null;
    s.lastStatsRun ??= null;
    const date = sessionDate(this.env.TIMEZONE);
    if (s.date !== date) {
      s.date = date;
      s.players = Object.fromEntries(SLOTS.map((k) => [k, blankPlayer()]));
      s.feed = [];
    }
    return s;
  }

  async save(s) {
    await this.ctx.storage.put("state", s);
  }

  async subs() {
    return (await this.ctx.storage.get("subs")) || {};
  }

  view(s, subs, slot) {
    return {
      me: slot,
      names: s.names,
      pubg: s.pubg,
      statsEnabled: !!this.env.PUBG_API_KEY,
      date: s.date,
      players: s.players,
      feed: s.feed,
      lastSession: s.lastSession,
      lastStatsRun: s.lastStatsRun,
      devices: Object.fromEntries(SLOTS.map((k) => [k, (subs[k] || []).length])),
    };
  }

  async pushTo(slot, payload) {
    const all = await this.subs();
    const list = all[slot] || [];
    const subject =
      this.env.VAPID_SUBJECT || (await this.ctx.storage.get("origin")) || "mailto:pager@example.invalid";
    let delivered = 0;
    const keep = [];
    for (const sub of list) {
      let status = 0;
      try {
        status = await sendPush(sub, payload, this.env, subject);
      } catch (e) {
        console.log("push error", e);
      }
      if (status >= 200 && status < 300) delivered++;
      if (status !== 404 && status !== 410) keep.push(sub);
    }
    if (keep.length !== list.length) {
      all[slot] = keep;
      await this.ctx.storage.put("subs", all);
    }
    return delivered;
  }

  async fetch(request) {
    const env = this.env;
    if (!env.PAIR_CODE || !env.VAPID_JWK) {
      return json({ error: "Server isn't set up yet. Run: npm run setup" }, 503);
    }
    const code = (request.headers.get("x-pair-code") || "").trim().toUpperCase();
    if (code !== env.PAIR_CODE.trim().toUpperCase()) return json({ error: "Wrong pair code" }, 401);

    // Remember this app's own address; push services use it to know who is sending.
    const origin = new URL(request.url).origin;
    if (origin.startsWith("https://") && (await this.ctx.storage.get("origin")) !== origin) {
      await this.ctx.storage.put("origin", origin);
    }

    let body = {};
    if (request.method === "POST") {
      try {
        body = await request.json();
      } catch {}
    }
    const path = new URL(request.url).pathname;
    const s = await this.load();

    // Pairing: type your name. A new name takes a free spot; a name already on the pager
    // signs you back in to that spot (for a new phone, or after unpairing).
    if (path === "/api/pair") {
      const name = cleanName(body.name);
      if (!name) return json({ error: "Enter a name: 1-16 letters or numbers." }, 400);
      let slot = SLOTS.find((k) => s.names[k]?.toLowerCase() === name.toLowerCase());
      if (!slot) {
        slot = SLOTS.find((k) => !s.names[k]);
        if (!slot) {
          return json(
            {
              error: `This pager already has two people: ${s.names.p1} and ${s.names.p2}. Type one of those names, or reset the pager from Settings.`,
            },
            409
          );
        }
        s.names[slot] = name;
        await this.save(s);
      }
      return json({ ok: true, slot, name: s.names[slot], vapidKey: await vapidPublicKey(env.VAPID_JWK) });
    }

    const slot = request.headers.get("x-user") || "";
    if (!SLOTS.includes(slot) || !s.names[slot]) {
      return json({ error: "This pager was reset. Pair again." }, 401);
    }
    const other = otherOf(slot);
    const myName = s.names[slot];
    const otherName = s.names[other] || "Your friend";

    if (path === "/api/state") {
      return json(this.view(s, await this.subs(), slot));
    }

    if (path === "/api/profile") {
      if (body.name !== undefined) {
        const name = cleanName(body.name);
        if (!name) return json({ error: "Names are 1-16 letters or numbers." }, 400);
        if (s.names[other]?.toLowerCase() === name.toLowerCase()) {
          return json({ error: "Your friend already uses that name." }, 400);
        }
        s.names[slot] = name;
      }
      if (body.pubg !== undefined) {
        const p = cleanPubg(body.pubg);
        if (p === null) return json({ error: "That doesn't look like a PUBG name." }, 400);
        s.pubg[slot] = p || null;
      }
      await this.save(s);
      return json(this.view(s, await this.subs(), slot));
    }

    if (path === "/api/reset") {
      if (body.confirm !== "RESET") return json({ error: "Reset not confirmed" }, 400);
      await this.ctx.storage.delete("subs");
      await this.ctx.storage.delete("state");
      return json({ ok: true });
    }

    if (path === "/api/subscribe") {
      const sub = body.subscription;
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
        return json({ error: "Bad subscription" }, 400);
      }
      const all = await this.subs();
      for (const k of Object.keys(all)) all[k] = all[k].filter((x) => x.endpoint !== sub.endpoint);
      all[slot] = [...(all[slot] || []), { endpoint: sub.endpoint, keys: sub.keys }].slice(-4);
      await this.ctx.storage.put("subs", all);
      return json({ ok: true });
    }

    if (path === "/api/unsubscribe") {
      const all = await this.subs();
      for (const k of Object.keys(all)) all[k] = all[k].filter((x) => x.endpoint !== body.endpoint);
      await this.ctx.storage.put("subs", all);
      return json({ ok: true });
    }

    if (path === "/api/test-push") {
      const delivered = await this.pushTo(slot, {
        title: "Game Pager",
        body: "Test page. Alerts are working.",
        tag: "pager-test",
      });
      return json({ delivered });
    }

    if (path === "/api/stats/refresh") {
      const hours = Math.min(Math.max(Number(body.hours) || 24, 1), 336);
      return json(await this.runStats({ hours, notify: false }));
    }

    if (path === "/api/action") {
      const p = s.players[slot];
      const v = body.value;
      let msg;
      let push;

      switch (body.type) {
        case "ask":
          msg = `${myName}: You on tonight?`;
          push = { title: `${myName} paged you`, body: "You on tonight?" };
          break;
        case "reply": {
          const text = { yes: "I'm in tonight", maybe: "Maybe tonight", no: "Can't play tonight" }[v];
          if (!text) return json({ error: "Bad reply" }, 400);
          p.status = v;
          if (v !== "yes") Object.assign(p, { time: null, lateBy: 0, onlineAt: null });
          msg = `${myName}: ${text}`;
          push = { title: myName, body: text };
          break;
        }
        case "time": {
          if (!/^\d{2}:\d{2}$/.test(v || "")) return json({ error: "Bad time" }, 400);
          Object.assign(p, { status: "yes", time: v, lateBy: 0 });
          msg = `${myName}: On at ${fmt12(v)}`;
          push = { title: myName, body: `I'm on at ${fmt12(v)}` };
          break;
        }
        case "late": {
          const m = parseInt(v, 10);
          if (!(m > 0 && m <= 240)) return json({ error: "Bad minutes" }, 400);
          p.lateBy = m;
          const eta = p.time ? ` (now ~${fmt12(addMin(p.time, m))})` : "";
          msg = `${myName}: Running ${m} late`;
          push = { title: myName, body: `Running ${m} min late${eta}` };
          break;
        }
        case "now":
          Object.assign(p, { status: "yes", onlineAt: Date.now() });
          msg = `${myName}: Hopping on NOW`;
          push = { title: `${myName} is hopping on NOW`, body: "Get in here." };
          break;
        default:
          return json({ error: "Unknown action" }, 400);
      }

      s.feed = [...s.feed, { at: Date.now(), from: slot, text: msg }].slice(-8);
      await this.save(s);
      const delivered = s.names[other] ? await this.pushTo(other, { ...push, tag: `pager-${body.type}` }) : 0;
      return json({ ...this.view(s, await this.subs(), slot), delivered, otherName });
    }

    return json({ error: "Not found" }, 404);
  }

  // Optional PUBG stats: runs from the daily cron and the "Check stats now" button.
  async runStats({ hours = 24, notify = false } = {}) {
    const s = await this.load();
    if (!this.env.PUBG_API_KEY) return { error: "Stats aren't set up on this pager" };
    const names = SLOTS.map((k) => s.pubg[k]).filter(Boolean);
    if (!names.length) return { error: "Add a PUBG name in Settings first" };

    let result;
    try {
      result = await collectSession({
        names,
        key: this.env.PUBG_API_KEY,
        since: Date.now() - hours * 3600e3,
      });
    } catch (e) {
      s.lastStatsRun = { at: Date.now(), ok: false, error: String(e.message || e) };
      await this.save(s);
      return { error: s.lastStatsRun.error };
    }
    s.lastStatsRun = { at: Date.now(), ok: true, games: result.games, missing: result.missing };
    if (result.games > 0) {
      s.lastSession = {
        ...result,
        date: sessionDate(this.env.TIMEZONE, Date.parse(result.matches[0].at)),
        fetchedAt: Date.now(),
      };
    }
    await this.save(s);

    if (notify && result.games > 0) {
      const d = result.wins === 1 ? "1 chicken dinner" : `${result.wins} chicken dinners`;
      const payload = {
        title: "Last session stats are in",
        body: `${result.games} games · ${d} · ${result.kills} kills`,
        tag: "pager-stats",
      };
      for (const k of SLOTS) if (s.names[k]) await this.pushTo(k, payload);
    }
    return { ok: true, games: result.games, missing: result.missing, lastSession: s.lastSession };
  }
}
