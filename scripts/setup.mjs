// One-time setup: you choose a pair code, optionally add a PUBG API key, and this
// makes the notification keys. All of it is stored as secrets on YOUR Cloudflare
// account — never in these files.
//
// `npm run setup:local` does the same but writes them to .dev.vars instead, for
// testing on your own computer with `npm run dev` (nothing goes to Cloudflare).
import { createInterface } from "node:readline/promises";
import { writeFileSync, unlinkSync } from "node:fs";

const LOCAL = process.argv.includes("--local");
import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";

const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log(`
Game Pager setup${LOCAL ? " (local test: saves to .dev.vars)" : ""}
----------------
Choose a pair code. You and your friend both type it into the app to connect.
Make it hard to guess: at least 6 characters (letters and numbers).
`);

let pair = "";
while (true) {
  pair = (await rl.question("Pair code: ")).trim();
  if (/^[A-Za-z0-9-]{6,32}$/.test(pair)) break;
  console.log("  Use 6-32 letters, numbers or dashes. Try again.");
}

console.log(`
Optional: PUBG stats. If you play PUBG on Steam, paste a free API key from
https://developer.pubg.com and the pager will show last night's stats.
Press Enter to skip.
`);
const pubgKey = (await rl.question("PUBG API key (or Enter to skip): ")).trim();
rl.close();

const kp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const jwk = await webcrypto.subtle.exportKey("jwk", kp.privateKey);

const secrets = { PAIR_CODE: pair, VAPID_JWK: JSON.stringify({ x: jwk.x, y: jwk.y, d: jwk.d }) };
if (pubgKey) secrets.PUBG_API_KEY = pubgKey;

if (LOCAL) {
  // Single quotes keep the JSON value exactly as-is. .dev.vars is in .gitignore.
  const lines = Object.entries(secrets).map(([k, v]) => `${k}='${v}'`);
  writeFileSync(".dev.vars", lines.join("\n") + "\n");
  console.log("\nSaved to .dev.vars (local only). Start the test server with: npm run dev");
} else {
  const file = ".secrets.tmp.json";
  writeFileSync(file, JSON.stringify(secrets));
  try {
    const r = spawnSync("npx", ["wrangler", "secret", "bulk", file], { stdio: "inherit", shell: true });
    if (r.status !== 0) throw new Error("Uploading secrets failed. Did you run `npm run deploy` first?");
  } finally {
    unlinkSync(file);
  }
}

console.log(`
All set. Your pair code is: ${pair.toUpperCase()}
${LOCAL ? "Open http://localhost:8787 once `npm run dev` is running." : "Send your friend the app link and the pair code. Keep the code private."}
${pubgKey ? "PUBG stats: on." : "PUBG stats: off (" + (LOCAL ? "add a PUBG_API_KEY line to .dev.vars" : "run `npx wrangler secret put PUBG_API_KEY`") + " to add later)."}
`);
