// Standard Web Push (VAPID + aes128gcm, RFC 8291/8292) using only WebCrypto,
// so it runs on Cloudflare Workers with no Firebase and no dependencies.
// Works for Chrome/Android (FCM endpoints) and iPhone home-screen apps (Apple endpoints).

const enc = new TextEncoder();

export function b64urlEncode(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

let cached = null;
async function loadVapid(jwkJson) {
  if (cached && cached.src === jwkJson) return cached;
  const jwk = JSON.parse(jwkJson);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const pub = concat(new Uint8Array([4]), b64urlDecode(jwk.x), b64urlDecode(jwk.y));
  cached = { src: jwkJson, privateKey, publicB64: b64urlEncode(pub) };
  return cached;
}

export async function vapidPublicKey(jwkJson) {
  return (await loadVapid(jwkJson)).publicB64;
}

async function vapidAuth(endpoint, subject, jwkJson) {
  const v = await loadVapid(jwkJson);
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(
    enc.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: subject,
      })
    )
  );
  const unsigned = `${header}.${claims}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    v.privateKey,
    enc.encode(unsigned)
  );
  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${v.publicB64}`;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8)
  );
}

export async function encryptPayload(plaintext, p256dhB64, authB64) {
  const uaPublic = b64urlDecode(p256dhB64);
  const authSecret = b64urlDecode(authB64);
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256)
  );
  const ikm = await hkdf(
    authSecret,
    ecdh,
    concat(enc.encode("WebPush: info\0"), uaPublic, asPublic),
    32
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      concat(plaintext, new Uint8Array([2]))
    )
  );
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, ct);
}

// Returns the push service's HTTP status (201 = delivered to the push service,
// 404/410 = that phone's subscription is dead and should be removed).
// `subject` identifies who is sending (your app's own https address or a mailto: link).
export async function sendPush(sub, payload, env, subject) {
  const body = await encryptPayload(
    enc.encode(JSON.stringify(payload)),
    sub.keys.p256dh,
    sub.keys.auth
  );
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuth(sub.endpoint, subject, env.VAPID_JWK),
      TTL: "43200",
      Urgency: "high",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
    },
    body,
  });
  return res.status;
}
