// Pulls recent matches for both players from the official PUBG API (Steam shard)
// and sums up one play session.

const BASE = "https://api.pubg.com/shards/steam";
const ACCEPT = "application/vnd.api+json";
const MAX_MATCH_FETCHES = 40; // keeps us under Cloudflare's free-plan request limit

const MAPS = {
  Baltic_Main: "Erangel",
  Erangel_Main: "Erangel",
  Desert_Main: "Miramar",
  Savage_Main: "Sanhok",
  DihorOtok_Main: "Vikendi",
  Tiger_Main: "Taego",
  Kiki_Main: "Deston",
  Neon_Main: "Rondo",
  Chimera_Main: "Paramo",
  Summerland_Main: "Karakin",
  Heaven_Main: "Haven",
};

async function pubgFetch(path, key) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${key}`, Accept: ACCEPT },
  });
  if (!res.ok) {
    const e = new Error(`PUBG API returned ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

async function getPlayers(names, key) {
  const q = (list) => `/players?filter[playerNames]=${list.map(encodeURIComponent).join(",")}`;
  try {
    return (await pubgFetch(q(names), key)).data || [];
  } catch (e) {
    if (e.status !== 404) throw e;
    // One of the names wasn't found; look them up one at a time.
    const out = [];
    for (const n of names) {
      try {
        out.push(...((await pubgFetch(q([n]), key)).data || []));
      } catch (e2) {
        if (e2.status !== 404) throw e2;
      }
    }
    return out;
  }
}

export async function collectSession({ names, key, since }) {
  const players = await getPlayers(names, key);
  const lower = names.map((n) => n.toLowerCase());
  const missing = names.filter(
    (n) => !players.some((p) => p.attributes.name.toLowerCase() === n.toLowerCase())
  );

  const fetched = new Map();
  let fetches = 0;
  const getMatch = async (id) => {
    if (fetched.has(id)) return fetched.get(id);
    if (fetches >= MAX_MATCH_FETCHES) return null;
    fetches++;
    const res = await fetch(`${BASE}/matches/${id}`, { headers: { Accept: ACCEPT } });
    const m = res.ok ? await res.json() : null;
    fetched.set(id, m);
    return m;
  };

  const inWindow = new Map();
  for (const p of players) {
    for (const { id } of p.relationships?.matches?.data || []) {
      const m = await getMatch(id);
      if (!m) continue;
      if (Date.parse(m.data.attributes.createdAt) < since) break; // list is newest first
      inWindow.set(id, m);
    }
  }

  const per = {};
  for (const n of names) per[n] = { name: n, games: 0, wins: 0, top10: 0, kills: 0, damage: 0, bestKills: 0 };
  const matches = [];
  let wins = 0;
  let top10 = 0;

  for (const m of inWindow.values()) {
    const a = m.data.attributes;
    if (a.mapName === "Range_Main") continue; // Camp Jackal training
    const ours = (m.included || [])
      .filter((x) => x.type === "participant")
      .map((x) => x.attributes.stats)
      .filter((s) => lower.includes((s.name || "").toLowerCase()));
    if (!ours.length) continue;
    const place = Math.min(...ours.map((s) => s.winPlace || 999));
    if (place === 1) wins++;
    if (place <= 10) top10++;
    let kills = 0;
    for (const s of ours) {
      const q = per[names[lower.indexOf(s.name.toLowerCase())]];
      q.games++;
      if (s.winPlace === 1) q.wins++;
      if (s.winPlace <= 10) q.top10++;
      q.kills += s.kills || 0;
      q.damage += Math.round(s.damageDealt || 0);
      q.bestKills = Math.max(q.bestKills, s.kills || 0);
      kills += s.kills || 0;
    }
    matches.push({ at: a.createdAt, map: MAPS[a.mapName] || a.mapName, mode: a.gameMode, place, kills });
  }

  matches.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  return {
    games: matches.length,
    wins,
    top10,
    kills: Object.values(per).reduce((n, q) => n + q.kills, 0),
    players: per,
    matches,
    missing,
  };
}
