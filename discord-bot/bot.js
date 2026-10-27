/* DasherDex Discord bot, run by GitHub about once an hour (free, no server needed).
   1. Levels: chatting earns XP; your first message of the day is your daily check-in (+ streak bonus).
      Level roles match the app: Rookie, Regular, Road Pro, Route Boss, Dex Master, Living Legend, Mythic Driver.
   2. Leaderboard: keeps one message in the leaderboard channel up to date.
   3. New drivers: posts each new DasherDex username, player ID and Gmail to the private new-drivers channel.
   It only works inside your DasherDex server and never DMs anyone. */
const L = require("./lib");
const LEVEL_ROLES = [[30, "mythic driver"], [22, "living legend"], [15, "dex master"], [10, "route boss"], [6, "road pro"], [3, "regular"], [1, "rookie"]];
const XP_MSG = 5, MSG_CAP = 20, XP_CHECKIN = 25, STREAK_STEP = 5, STREAK_MAX = 25;
const needXP = lv => 50 * lv * (lv - 1);                 // level 2: 100 XP, 6: 1,500, 10: 4,500, 30: 43,500
const levelOf = xp => { let lv = 1; while (needXP(lv + 1) <= xp) lv++; return lv; };
const STATE_DOC = "/discordbot/state";
const SETUP_VER = 2;
/* permission numbers */
const P = { view: 1024n, send: 2048n, history: 65536n, react: 64n, embed: 16384n, attach: 32768n, threads: 34359738368n, sendThreads: 274877906944n,
  connect: 1048576n, speak: 2097152n, voiceAct: 33554432n, extEmoji: 262144n, invite: 1n, manageMsgs: 8192n, timeout: 1099511627776n, admin: 8n };
const perm = list => list.reduce((a, x) => a | x, 0n).toString();
const SAFE_EVERYONE = perm([P.view, P.send, P.history, P.react, P.embed, P.attach, P.threads, P.sendThreads, P.connect, P.speak, P.voiceAct, P.extEmoji, P.invite]);
const ACTIVITY_ROLES = [["🌱 Newcomer", 0x7ab648], ["💬 Chatterbox", 0x5f8dff], ["🔥 On Fire", 0xff8a3d], ["🎖️ Veteran", 0xc9ccd6]];

async function loadState() {
  const d = await L.fs("GET", STATE_DOC);
  let s = {}; try { s = JSON.parse(L.fieldsOf(d).json || "{}"); } catch (e) {}
  return { v: 1, users: {}, after: {}, lastSignup: 0, board: "", ...s };
}
async function saveState(s) {
  await L.fs("PATCH", STATE_DOC, { fields: { json: { stringValue: JSON.stringify(s) }, at: { integerValue: String(Date.now()) } } });
}

async function levels(state, chans, roles) {
  const cat = chans.find(c => c.type === 4 && L.keyOf(c.name) === "community");
  const counted = chans.filter(c => (c.type === 0 || c.type === 5) && cat && c.parent_id === cat.id);
  if (!counted.length) { console.log("No COMMUNITY channels found; skipping levels."); return false; }
  const since = L.snowflakeAt(Date.now() - 24 * 3600e3);
  const msgs = [];
  for (const ch of counted) {
    let after = state.after[ch.id] || since;
    for (let page = 0; page < 30; page++) {
      const batch = await L.discord("GET", `/channels/${ch.id}/messages?limit=100&after=${after}`);
      if (!batch.length) break;
      for (const m of batch) if (!m.author.bot && !m.webhook_id && (m.type === 0 || m.type === 19)) msgs.push(m);
      after = batch.map(m => m.id).sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1))[0];
      if (batch.length < 100) break;
    }
    state.after[ch.id] = after;
  }
  msgs.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const ups = [];
  for (const m of msgs) {
    const id = m.author.id, day = L.dayKey(Date.parse(m.timestamp));
    const u = state.users[id] || (state.users[id] = { xp: 0, lv: 1, day: "", n: 0, streak: 0, last: "" });
    u.name = m.author.global_name || m.author.username;
    u.total = (u.total || 0) + 1; if (!u.first) u.first = Date.parse(m.timestamp);
    if (u.joined === undefined) { const mem = await L.discord("GET", `/guilds/${L.GUILD}/members/${id}`).catch(() => null); u.joined = mem && mem.joined_at ? Date.parse(mem.joined_at) : 0; }
    const before = u.lv;
    if (u.day !== day) { u.day = day; u.n = 0; }
    if (u.n < MSG_CAP) { u.xp += XP_MSG; u.n++; }
    if (u.last !== day) {          // daily check-in: first message of the day
      u.streak = u.last === L.prevDay(day) ? u.streak + 1 : 1; u.last = day;
      u.xp += XP_CHECKIN + Math.min(STREAK_MAX, STREAK_STEP * (u.streak - 1));
    }
    u.lv = levelOf(u.xp);
    if (u.lv > before || !u.role) ups.push(id);
  }
  // level roles and level-up posts
  const lvlCh = L.findChan(chans, "level-ups");
  const roleFor = lv => { const t = LEVEL_ROLES.find(([min]) => lv >= min); return t && roles.find(r => L.nounOf(r.name) === t[1]); };
  const levelRoleIds = new Set(LEVEL_ROLES.map(([, n]) => (roles.find(r => L.nounOf(r.name) === n) || {}).id).filter(Boolean));
  for (const id of [...new Set(ups)]) {
    const u = state.users[id], r = roleFor(u.lv);
    try {
      let newRole = "";
      if (r && u.role !== r.id) {
        const mem = await L.discord("GET", `/guilds/${L.GUILD}/members/${id}`).catch(() => null);
        if (!mem) continue;            // left the server
        await L.discord("PUT", `/guilds/${L.GUILD}/members/${id}/roles/${r.id}`);
        for (const old of mem.roles) if (old !== r.id && levelRoleIds.has(old)) await L.discord("DELETE", `/guilds/${L.GUILD}/members/${id}/roles/${old}`);
        if (u.role) newRole = r.name;
        u.role = r.id;
      }
      if (lvlCh && u.lv > 1 && (u.announced || 1) < u.lv)
        await L.discord("POST", `/channels/${lvlCh.id}/messages`, { content: `🎉 <@${id}> reached **Level ${u.lv}**${newRole ? ` and is now **${newRole}**` : ""}!`, allowed_mentions: { parse: [] } });
      u.announced = u.lv;
    } catch (e) { console.warn("Level role for " + id + ": " + e.message); }
  }
  console.log(`Levels: ${msgs.length} new messages, ${new Set(ups).size} members updated, ${Object.keys(state.users).length} members tracked.`);
  return msgs.length > 0;
}

/* keeps the server tidy and locked down. Runs once per SETUP_VER, so it never fights changes you make by hand later. */
async function upkeep(state, chans, roles) {
  if ((state.setup || 0) >= SETUP_VER) return false;
  const head = roles.find(r => L.nounOf(r.name) === "head mod"), mod = roles.find(r => L.nounOf(r.name) === "mod");
  // @everyone: only safe everyday permissions (no pinging everyone, no managing anything)
  await L.discord("PATCH", `/guilds/${L.GUILD}/roles/${L.GUILD}`, { permissions: SAFE_EVERYONE }).catch(e => console.warn("everyone perms: " + e.message));
  // Mods: delete messages and time people out. Helpers: delete messages. Only the Head Mod can do more.
  const basic = [P.view, P.send, P.history, P.react, P.embed, P.attach, P.threads, P.sendThreads, P.connect, P.speak];
  if (mod) await L.discord("PATCH", `/guilds/${L.GUILD}/roles/${mod.id}`, { permissions: perm([...basic, P.manageMsgs, P.timeout]) }).catch(() => {});
  const helper = roles.find(r => L.nounOf(r.name) === "helper");
  if (helper) await L.discord("PATCH", `/guilds/${L.GUILD}/roles/${helper.id}`, { permissions: perm([...basic, P.manageMsgs]) }).catch(() => {});
  // activity roles the bot hands out
  for (const [name, color] of ACTIVITY_ROLES) if (!roles.some(r => L.nounOf(r.name) === L.nounOf(name))) {
    const r = await L.discord("POST", `/guilds/${L.GUILD}/roles`, { name, color, hoist: false, mentionable: false, permissions: "0" }).catch(() => null); if (r) roles.push(r);
  }
  // head-mod-only channels: new drivers (with Gmails) and suspicious activity
  const modsCat = chans.find(c => c.type === 4 && L.keyOf(c.name) === "mods");
  const headOnly = [{ id: L.GUILD, type: 0, allow: "0", deny: P.view.toString() }].concat(mod ? [{ id: mod.id, type: 0, allow: "0", deny: P.view.toString() }] : [])
    .concat(head ? [{ id: head.id, type: 0, allow: perm([P.view, P.send, P.history]), deny: "0" }] : []);
  let nd = L.findChan(chans, "new-drivers");
  if (nd) await L.discord("PATCH", `/channels/${nd.id}`, { permission_overwrites: headOnly, topic: "New DasherDex accounts: username, ID and Gmail. Only the Head Mod can see this." }).catch(() => {});
  let sus = L.findChan(chans, "sus-alerts");
  if (!sus) { sus = await L.discord("POST", `/guilds/${L.GUILD}/channels`, { name: "🚩・sus-alerts", type: 0, parent_id: modsCat ? modsCat.id : undefined, permission_overwrites: headOnly, topic: "Suspicious offers and reports from the app, the moment they happen. Head Mod only." }).catch(() => null); if (sus) chans.push(sus); }
  state.setup = SETUP_VER; console.log("Server upkeep done (v" + SETUP_VER + ")"); return true;
}

/* instant alerts: the app posts new drivers and suspicious activity straight to Discord through these webhooks.
   The bot makes them and stores their addresses in your database; it remakes them if one is ever deleted. */
async function hooks(state, chans) {
  const want = [["signup", "new-drivers"], ["sus", "sus-alerts"]], out = {};
  for (const [k, ch] of want) {
    const c = L.findChan(chans, ch); if (!c) continue;
    const list = await L.discord("GET", `/channels/${c.id}/webhooks`).catch(() => []);
    let w = list.find(x => x.name === "DasherDex Alerts" && x.token);
    if (!w) w = await L.discord("POST", `/channels/${c.id}/webhooks`, { name: "DasherDex Alerts" }).catch(() => null);
    if (w && w.token) out[k] = `https://discord.com/api/webhooks/${w.id}/${w.token}`;
  }
  const sig = JSON.stringify(out);
  if (Object.keys(out).length && sig !== state.hooks) {
    await L.fs("PATCH", "/config/hooks", { fields: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { stringValue: v }]).concat([["upd", { integerValue: String(Date.now()) }]])) });
    state.hooks = sig; console.log("Alert webhooks saved for the app");
  }
}

/* activity roles: newcomers for their first week, chatty members, streaks, and long-time regulars */
async function activityRoles(state, roles) {
  const R = Object.fromEntries(ACTIVITY_ROLES.map(([n]) => [L.nounOf(n), roles.find(r => L.nounOf(r.name) === L.nounOf(n))]));
  const today = L.dayKey(Date.now()), now = Date.now();
  for (const [id, u] of Object.entries(state.users)) {
    u.roles = u.roles || {};
    const want = {
      newcomer: u.joined ? now - u.joined < 7 * 864e5 : false,
      chatterbox: (u.total || 0) >= 250,
      "on fire": u.streak >= 7 && (u.last === today || u.last === L.prevDay(today)),
      veteran: u.first ? now - u.first >= 60 * 864e5 && u.lv >= 6 : false
    };
    for (const [k, on] of Object.entries(want)) {
      const role = R[k]; if (!role || !!u.roles[k] === on) continue;
      try { await L.discord(on ? "PUT" : "DELETE", `/guilds/${L.GUILD}/members/${id}/roles/${role.id}`); u.roles[k] = on ? 1 : 0; } catch (e) { if (e.status === 404) u.roles[k] = on ? 1 : 0; }
    }
  }
}

async function leaderboard(state, chans) {
  const ch = L.findChan(chans, "leaderboard"); if (!ch) return;
  const top = Object.entries(state.users).sort((a, b) => b[1].xp - a[1].xp).slice(0, 15);
  const medal = i => ["🥇", "🥈", "🥉"][i] || `**${i + 1}.**`;
  const lines = top.map(([id, u], i) => `${medal(i)} <@${id}> · Level ${u.lv} · ${u.xp.toLocaleString("en-US")} XP${u.streak > 1 && u.last === L.dayKey(Date.now()) ? ` · 🔥${u.streak}` : ""}`);
  const content = `**🏆 DasherDex leaderboard**\n${lines.join("\n") || "Nobody yet. Say hi in check-in to get on the board!"}\n\n_Updated <t:${Math.floor(Date.now() / 1000)}:R>. Chat and check in daily to climb._`;
  const body = { content, allowed_mentions: { parse: [] } };
  if (state.board) { try { await L.discord("PATCH", `/channels/${ch.id}/messages/${state.board}`, body); return; } catch (e) { if (e.status !== 404) throw e; } }
  const m = await L.discord("POST", `/channels/${ch.id}/messages`, body); state.board = m.id;
}

async function newDrivers(state, chans) {
  const ch = L.findChan(chans, "new-drivers"); if (!ch) { console.log("No new-drivers channel; skipping."); return; }
  const q = { structuredQuery: { from: [{ collectionId: "signups" }], where: { fieldFilter: { field: { fieldPath: "at" }, op: "GREATER_THAN", value: { integerValue: String(state.lastSignup || 0) } } }, orderBy: [{ field: { fieldPath: "at" }, direction: "ASCENDING" }], limit: 25 } };
  const rows = (await L.fs("POST", ":runQuery", q)) || [];
  let n = 0;
  for (const row of rows) {
    if (!row.document) continue;
    const s = L.fieldsOf(row.document), uid = row.document.name.split("/").pop();
    if (s.hk) { state.lastSignup = Math.max(state.lastSignup || 0, s.at || 0); continue; }   // already sent instantly by the app
    const user = L.fieldsOf(await L.fs("GET", "/users/" + uid));
    const fields = [
      { name: "Username", value: "@" + (s.username || user.username || "?"), inline: true },
      { name: "Player ID", value: user.code ? L.fmtID(user.code) : "not made yet", inline: true },
      { name: "Gmail", value: s.email || "?", inline: false },
      { name: "Google name", value: String(s.name || user.name || "?").slice(0, 60), inline: true },
      { name: "Joined", value: `<t:${Math.floor((s.at || Date.now()) / 1000)}:f>`, inline: true }];
    await L.discord("POST", `/channels/${ch.id}/messages`, { embeds: [{ title: "🆕 New DasherDex driver", color: 0x5f8dff, fields, footer: { text: "Private: only mods can see this channel." } }], allowed_mentions: { parse: [] } });
    state.lastSignup = Math.max(state.lastSignup || 0, s.at || 0); n++;
  }
  console.log(`New drivers posted: ${n}`);
}

(async () => {
  L.need(); await L.checkGuild();
  const state = await loadState();
  const [chans, roles] = await Promise.all([L.channels(), L.discord("GET", `/guilds/${L.GUILD}/roles`)]);
  try { await upkeep(state, chans, roles); } catch (e) { console.error("Upkeep: " + e.message); }
  try { await hooks(state, chans); } catch (e) { console.error("Webhooks: " + e.message); }
  try { await newDrivers(state, chans); } catch (e) { console.error("New drivers: " + e.message); }
  await levels(state, chans, roles);
  try { await activityRoles(state, roles); } catch (e) { console.error("Activity roles: " + e.message); }
  await leaderboard(state, chans);
  await saveState(state);
  console.log("Done.");
})().catch(e => { console.error(e.message); process.exit(1); });
