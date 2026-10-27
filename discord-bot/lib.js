/* Shared helpers for the DasherDex Discord automations (no installs needed: Node 20 only). */
const crypto = require("crypto");
const API = process.env.DISCORD_API || "https://discord.com/api/v10";
const TOKEN = (process.env.DISCORD_BOT_TOKEN || "").trim();
const GUILD = (process.env.DISCORD_GUILD_ID || "").trim();
const TZ = "America/Chicago";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function need() {
  const miss = [];
  if (!TOKEN) miss.push("DISCORD_BOT_TOKEN");
  if (!/^\d{17,20}$/.test(GUILD)) miss.push("DISCORD_GUILD_ID");
  if (miss.length) { console.error("Missing GitHub secret(s): " + miss.join(", ") + ". Add them in your repo: Settings > Secrets and variables > Actions."); process.exit(1); }
}

/* Discord REST with polite waiting when Discord says "slow down" */
async function discord(method, path, body) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(API + path, { method, headers: { Authorization: "Bot " + TOKEN, "Content-Type": "application/json", "User-Agent": "DiscordBot (https://dasherdex.web.app, 2.0)" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status === 429) { const j = await r.json().catch(() => ({})); await sleep(((j.retry_after || 2) + 0.3) * 1000); continue; }
    if (r.status === 204) return true;
    const txt = await r.text();
    if (!r.ok) { const e = new Error(`Discord ${method} ${path} -> ${r.status} ${txt.slice(0, 300)}`); e.status = r.status; throw e; }
    await sleep(120);
    return txt ? JSON.parse(txt) : true;
  }
  throw new Error("Discord kept rate limiting " + path);
}

/* the bot must only ever work in the DasherDex server */
async function checkGuild() {
  const gs = await discord("GET", "/users/@me/guilds");
  if (!gs.some(g => g.id === GUILD)) throw new Error("The bot isn't in the server DISCORD_GUILD_ID points to.");
  const others = gs.filter(g => g.id !== GUILD);
  if (others.length) throw new Error("Safety stop: the bot is in other servers too (" + others.map(g => g.name).join(", ") + "). Remove it from those first.");
}

/* find channels and roles by name, ignoring emoji and the "・" separator */
const keyOf = n => String(n || "").replace(/^.*・/, "").replace(/[^\p{L}\p{N}-]/gu, "").toLowerCase();
const nounOf = n => String(n || "").replace(/^[^A-Za-z]+/, "").trim().toLowerCase();
async function channels() { return discord("GET", `/guilds/${GUILD}/channels`); }
function findChan(list, key, type = 0) { return list.find(c => c.type === type && keyOf(c.name) === key); }

/* Firestore (your Firebase database) with the FIREBASE_SERVICE_ACCOUNT secret you already have */
let sa = null, saTok = null;
function serviceAccount() {
  if (sa) return sa;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || "";
  try { sa = JSON.parse(raw); } catch (e) { throw new Error("FIREBASE_SERVICE_ACCOUNT secret is missing or isn't the JSON key file."); }
  return sa;
}
async function gToken() {
  if (saTok && saTok.exp > Date.now() + 60000) return saTok.t;
  if (process.env.FIRESTORE_TEST_TOKEN) return process.env.FIRESTORE_TEST_TOKEN;
  const s = serviceAccount(), now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "RS256", typ: "JWT" }), claim = b64({ iss: s.client_email, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const sig = crypto.createSign("RSA-SHA256").update(head + "." + claim).sign(s.private_key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + head + "." + claim + "." + sig });
  const j = await r.json(); if (!j.access_token) throw new Error("Google sign-in for the bot failed: " + JSON.stringify(j).slice(0, 200));
  saTok = { t: j.access_token, exp: Date.now() + 3500 * 1000 }; return saTok.t;
}
function fsBase() { return (process.env.FIRESTORE_URL || "https://firestore.googleapis.com/v1") + `/projects/${process.env.FIREBASE_PROJECT || serviceAccount().project_id}/databases/(default)/documents`; }
async function fs(method, path, body) {
  const r = await fetch(fsBase() + path, { method, headers: { Authorization: "Bearer " + (await gToken()), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 404) return null;
  const j = await r.json().catch(() => ({}));
  if (r.status === 403) throw new Error(`The service account (${(sa && sa.client_email) || "?"}) can't read the database. In Google Cloud > IAM, give it the role "Cloud Datastore User".`);
  if (!r.ok) throw new Error("Firestore " + r.status + " " + JSON.stringify(j).slice(0, 300));
  return j;
}
const val = v => !v ? null : "stringValue" in v ? v.stringValue : "integerValue" in v ? Number(v.integerValue) : "doubleValue" in v ? v.doubleValue : "booleanValue" in v ? v.booleanValue : "timestampValue" in v ? Date.parse(v.timestampValue) : null;
const fieldsOf = doc => { const o = {}; for (const [k, v] of Object.entries((doc && doc.fields) || {})) o[k] = val(v); return o; };

/* day keys in the head moderator's time zone */
const dayKey = t => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
const prevDay = k => { const d = new Date(k + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const snowflakeAt = ms => ((BigInt(ms) - 1420070400000n) << 22n).toString();
const fmtID = c => String(c || "").replace(/(.{4})(?=.)/g, "$1-");

module.exports = { discord, need, checkGuild, keyOf, nounOf, channels, findChan, fs, fieldsOf, dayKey, prevDay, snowflakeAt, fmtID, GUILD, sleep };
