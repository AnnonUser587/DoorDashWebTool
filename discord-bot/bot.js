/* DasherDex Discord bot, run by GitHub about once an hour (free, no server needed).
   1. Levels: chatting earns XP; your first message of the day is your daily check-in (+ streak bonus).
      Level roles match the app: Rookie, Regular, Road Pro, Route Boss, Dex Master, Living Legend, Mythic Driver.
   2. Leaderboard: keeps one message in the leaderboard channel up to date.
   3. New drivers: username and player ID to new-drivers (mods can see it); their Gmail only to the head-only channel.
   4. Server tidy-up, the pick-roles channel, AutoMod, the Head Mod role for dasherdexdev, and a weekly mod summary.
   The faster jobs (Newcomer role, pick-roles, !card, big pulls) are in fast.js, every 10 minutes.
   It only works inside your DasherDex server and never DMs anyone. */
const L = require("./lib");
const LEVEL_ROLES = [[30, "mythic driver"], [22, "living legend"], [15, "dex master"], [10, "route boss"], [6, "road pro"], [3, "regular"], [1, "rookie"]];
const XP_MSG = 5, MSG_CAP = 20, XP_CHECKIN = 25, STREAK_STEP = 5, STREAK_MAX = 25;
const needXP = lv => 50 * lv * (lv - 1);                 // level 2: 100 XP, 6: 1,500, 10: 4,500, 30: 43,500
const levelOf = xp => { let lv = 1; while (needXP(lv + 1) <= xp) lv++; return lv; };
const STATE_DOC = "/discordbot/state";
const SETUP_VER = 3;
const HEAD_USER = "dasherdexdev";   // this Discord account gets the Head Mod role (full access)
/* permission numbers */
const P = { view: 1024n, send: 2048n, history: 65536n, react: 64n, embed: 16384n, attach: 32768n, threads: 34359738368n, sendThreads: 274877906944n,
  connect: 1048576n, speak: 2097152n, voiceAct: 33554432n, extEmoji: 262144n, invite: 1n, manageMsgs: 8192n, timeout: 1099511627776n, admin: 8n };
const perm = list => list.reduce((a, x) => a | x, 0n).toString();
const SAFE_EVERYONE = perm([P.view, P.send, P.history, P.react, P.embed, P.attach, P.threads, P.sendThreads, P.connect, P.speak, P.voiceAct, P.extEmoji, P.invite]);
const ACTIVITY_ROLES = [["🌱 Newcomer", 0x7ab648], ["💬 Chatterbox", 0x5f8dff], ["🔥 On Fire", 0xff8a3d], ["🎖️ Veteran", 0xc9ccd6]];
/* roles people pick themselves in the pick-roles channel (fast.js keeps them in sync with the reactions) */
const PICK_ROLES = [["🚗", "🚗 DoorDash", 0xff3008], ["🍔", "🍔 Uber Eats", 0x06c167], ["🔔", "🔔 Update pings", 0xf5b83d], ["🇲🇽", "🇲🇽 Español", 0x2fb36b]];

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
    u.name = m.author.global_name || m.author.username; u.un = String(m.author.username || "").toLowerCase();
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
  const lvl0 = L.findChan(chans, "level-ups"), arch = chans.find(c => c.type === 4 && L.keyOf(c.name) === "archive");
  const lvlCh = lvl0 && !(arch && lvl0.parent_id === arch.id) ? lvl0 : null;   // archived: level-ups aren't posted any more
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

/* keeps the server tidy and locked down. Each step runs once per SETUP_VER, so it never fights changes you make by hand later. */
const headOnlyKey = list => L.findChan(list, "head-only") || L.findChan(list, "sus-alerts");
async function upkeep(state, chans, roles) {
  if ((state.setup || 0) >= SETUP_VER) return false;
  const head = roles.find(r => L.nounOf(r.name) === "head mod"), mod = roles.find(r => L.nounOf(r.name) === "mod");
  const ow = (id, allow, deny) => ({ id, type: 0, allow: allow ? perm(allow) : "0", deny: deny ? perm(deny) : "0" });
  if ((state.setup || 0) < 2) {
    // @everyone: only safe everyday permissions (no pinging everyone, no managing anything)
    await L.discord("PATCH", `/guilds/${L.GUILD}/roles/${L.GUILD}`, { permissions: SAFE_EVERYONE }).catch(e => console.warn("everyone perms: " + e.message));
    // Mods: delete messages and time people out. Helpers: delete messages. Only the Head Mod can do more.
    const basic = [P.view, P.send, P.history, P.react, P.embed, P.attach, P.threads, P.sendThreads, P.connect, P.speak];
    if (mod) await L.discord("PATCH", `/guilds/${L.GUILD}/roles/${mod.id}`, { permissions: perm([...basic, P.manageMsgs, P.timeout]) }).catch(() => {});
    const helper = roles.find(r => L.nounOf(r.name) === "helper");
    if (helper) await L.discord("PATCH", `/guilds/${L.GUILD}/roles/${helper.id}`, { permissions: perm([...basic, P.manageMsgs]) }).catch(() => {});
  }
  // roles the bot hands out, and roles people pick
  for (const [name, color] of ACTIVITY_ROLES.concat(PICK_ROLES.map(([, n, c]) => [n, c]))) if (!roles.some(r => L.nounOf(r.name) === L.nounOf(name))) {
    const r = await L.discord("POST", `/guilds/${L.GUILD}/roles`, { name, color, hoist: false, mentionable: false, permissions: "0" }).catch(() => null); if (r) roles.push(r);
  }
  // Head Mod: full access (Administrator)
  if (head) await L.discord("PATCH", `/guilds/${L.GUILD}/roles/${head.id}`, { permissions: P.admin.toString(), hoist: true }).catch(e => console.warn("Head Mod role: " + e.message + " (drag the bot's role above Head Mod in Server Settings > Roles)"));
  const cat = key => chans.find(c => c.type === 4 && L.keyOf(c.name) === key);
  const catInfo = cat("starthere") || cat("info"), catChat = cat("community"), catMods = cat("mods");
  // new drivers: mods and the Head Mod can read it (no Gmails here any more)
  const modsRead = [ow(L.GUILD, null, [P.view])].concat(mod ? [ow(mod.id, [P.view, P.history], [P.send])] : []).concat(head ? [ow(head.id, [P.view, P.send, P.history])] : []);
  const headOnly = [ow(L.GUILD, null, [P.view])].concat(mod ? [ow(mod.id, null, [P.view])] : []).concat(head ? [ow(head.id, [P.view, P.send, P.history])] : []);
  // the old new-drivers channel has Gmails in its history: it moves to the hidden archive (Head Mod only),
  // and mods get a fresh new-drivers channel with usernames and IDs only
  let arch = cat("archive");
  const mkArch = async () => { if (!arch) { arch = await L.discord("POST", `/guilds/${L.GUILD}/channels`, { name: "📦 ARCHIVE", type: 4, permission_overwrites: headOnly }).catch(() => null); if (arch) chans.push(arch); } return arch; };
  let nd = L.findChan(chans, "new-drivers");
  if (nd && !state.ndFresh) {
    await mkArch();
    await L.discord("PATCH", `/channels/${nd.id}`, { name: "🗄️・old-signups", parent_id: arch ? arch.id : nd.parent_id, permission_overwrites: headOnly, topic: "Sign-ups from before 1.8 (with Gmails). Head Mod only." }).then(c => { nd.name = (c && c.name) || "🗄️・old-signups"; if (arch) nd.parent_id = arch.id; }).catch(e => console.warn("old new-drivers: " + e.message));
    nd = null;
  }
  if (!nd) { nd = await L.discord("POST", `/guilds/${L.GUILD}/channels`, { name: "🆕・new-drivers", type: 0, parent_id: catMods ? catMods.id : undefined, permission_overwrites: modsRead, topic: "New DasherDex drivers: username and player ID. Mods and the Head Mod can see this." }).catch(() => null); if (nd) chans.push(nd); }
  else await L.discord("PATCH", `/channels/${nd.id}`, { permission_overwrites: modsRead, topic: "New DasherDex drivers: username and player ID. Mods and the Head Mod can see this." }).catch(() => {});
  state.ndFresh = 1;
  // the head-only channel: Gmails of new drivers, suspicious offers and reports
  let ho = headOnlyKey(chans);
  if (ho) await L.discord("PATCH", `/channels/${ho.id}`, { name: "🔒・head-only", permission_overwrites: headOnly, topic: "Head Mod only: new drivers' Gmails, suspicious offers, reports and the weekly mod summary." }).then(c => { if (c && c.name) ho.name = c.name; }).catch(() => {});
  else { ho = await L.discord("POST", `/guilds/${L.GUILD}/channels`, { name: "🔒・head-only", type: 0, parent_id: catMods ? catMods.id : undefined, permission_overwrites: headOnly, topic: "Head Mod only: new drivers' Gmails, suspicious offers, reports and the weekly mod summary." }).catch(() => null); if (ho) chans.push(ho); }
  // tidy up: level-up spam and the empty voice channel go to a hidden archive (nothing is deleted, you can move them back)
  const toArchive = [L.findChan(chans, "level-ups"), chans.find(c => c.type === 2 && /hangout|general/i.test(c.name))].filter(Boolean);
  if (toArchive.length) {
    await mkArch();
    if (arch) for (const c of toArchive) await L.discord("PATCH", `/channels/${c.id}`, { parent_id: arch.id, lock_permissions: true }).then(() => { c.parent_id = arch.id; console.log("Archived " + c.name); }).catch(e => console.warn("archive: " + e.message));
  }
  // best-pulls becomes big-pulls (the app can post Legendary and Mythic pulls there, if the driver turns it on)
  const bp = L.findChan(chans, "best-pulls");
  if (bp) await L.discord("PATCH", `/channels/${bp.id}`, { name: "🏆・big-pulls", topic: "Legendary and Mythic pulls. Drivers can share theirs automatically: Settings > Goals and sharing in the app." }).then(c => { if (c && c.name) bp.name = c.name; }).catch(() => {});
  // leaderboard moves into COMMUNITY; the empty LEVELS category is removed
  const lb = L.findChan(chans, "leaderboard"), lvl = cat("levels");
  if (lb && catChat && lb.parent_id !== catChat.id) await L.discord("PATCH", `/channels/${lb.id}`, { parent_id: catChat.id }).then(() => { lb.parent_id = catChat.id; }).catch(() => {});
  if (lvl && !chans.some(c => c.parent_id === lvl.id && c.id !== lvl.id)) await L.discord("DELETE", `/channels/${lvl.id}`).then(() => console.log("Removed empty LEVELS category")).catch(() => {});
  // pick your roles: a locked channel where you react to get roles
  let pr = L.findChan(chans, "pick-roles");
  if (!pr) { pr = await L.discord("POST", `/guilds/${L.GUILD}/channels`, { name: "🎭・pick-roles", type: 0, parent_id: catInfo ? catInfo.id : undefined, topic: "React to pick your roles. Remove your reaction to drop a role.",
    permission_overwrites: [ow(L.GUILD, [P.view, P.history, P.react], [P.send, P.threads, P.sendThreads])] }).catch(() => null); if (pr) chans.push(pr); }
  if (pr && !state.pickMsg) {
    const m = await L.discord("POST", `/channels/${pr.id}/messages`, { content: "**Pick your roles** 🎭\nReact below. Remove your reaction to drop the role.\n\n" + PICK_ROLES.map(([e, n]) => `${e}  ${n.replace(/^\S+\s/, "")}`).join("\n") + "\n\n_New here? You get the 🌱 Newcomer role for your first week. Roles show up within about 10 minutes._", allowed_mentions: { parse: [] } }).catch(() => null);
    if (m) { state.pickMsg = m.id; state.pickCh = pr.id; for (const [e] of PICK_ROLES) await L.discord("PUT", `/channels/${pr.id}/messages/${m.id}/reactions/${encodeURIComponent(e)}/@me`).catch(() => {}); await L.discord("PUT", `/channels/${pr.id}/pins/${m.id}`).catch(() => {}); }
  }
  // AutoMod (Discord's own auto moderator): made only if the setup tool didn't already
  try {
    const have = await L.discord("GET", `/guilds/${L.GUILD}/auto-moderation/rules`);
    const log = ho ? ho.id : undefined, exempt = [head, mod].filter(Boolean).map(r => r.id);
    const add = async (name, trigger_type, trigger_metadata, extra) => { if (have.some(r => r.name === name)) return;
      await L.discord("POST", `/guilds/${L.GUILD}/auto-moderation/rules`, { name, event_type: 1, trigger_type, trigger_metadata, enabled: true, exempt_roles: exempt,
        actions: [{ type: 1, metadata: { custom_message: "Keep it friendly. That message was blocked." } }].concat(log ? [{ type: 2, metadata: { channel_id: log } }] : []).concat(extra || []) }).catch(e => console.warn("AutoMod " + name + ": " + e.message)); };
    await add("DasherDex: slurs", 4, { presets: [3] });
    await add("DasherDex: spam", 3, undefined);
    await add("DasherDex: mention spam", 5, { mention_total_limit: 5, mention_raid_protection_enabled: true }, [{ type: 3, metadata: { duration_seconds: 600 } }]);
  } catch (e) { console.warn("AutoMod: " + e.message); }
  // a tidy order
  const order = ["welcome", "rules", "pick-roles", "announcements", "patch-notes", "general", "check-in", "offer-talk", "big-pulls", "bugs-and-ideas", "español", "espanol", "leaderboard", "mod-chat", "new-drivers", "head-only", "automod-log"];
  const pos = []; order.forEach((k, i) => { const c = L.findChan(chans, k); if (c) pos.push({ id: c.id, position: i }); });
  if (pos.length) await L.discord("PATCH", `/guilds/${L.GUILD}/channels`, pos).catch(() => {});
  state.setup = SETUP_VER; console.log("Server upkeep done (v" + SETUP_VER + ")"); return true;
}

/* the Head Mod role for the dasherdexdev account (checked every run, in case they rejoin) */
async function headUser(state, roles) {
  const head = roles.find(r => L.nounOf(r.name) === "head mod"); if (!head) { console.log("No Head Mod role found"); return; }
  let id = state.headId || "";
  if (!id) {
    const found = await L.discord("GET", `/guilds/${L.GUILD}/members/search?query=${HEAD_USER}&limit=5`).catch(() => []);
    const m = (found || []).find(x => x.user && String(x.user.username).toLowerCase() === HEAD_USER);
    if (m) id = m.user.id;
    else { const e = Object.entries(state.users).find(([, u]) => u.un === HEAD_USER); if (e) id = e[0]; }
  }
  if (!id) { console.log(`Head Mod: couldn't find @${HEAD_USER} yet (they need to be in the server; saying hi in a channel helps).`); return; }
  state.headId = id;
  const mem = await L.discord("GET", `/guilds/${L.GUILD}/members/${id}`).catch(() => null);
  if (!mem) { state.headId = ""; return; }
  if (!mem.roles.includes(head.id)) { await L.discord("PUT", `/guilds/${L.GUILD}/members/${id}/roles/${head.id}`).then(() => console.log(`@${HEAD_USER} is Head Mod`)).catch(e => console.warn("Head Mod for " + HEAD_USER + ": " + e.message)); }
}

/* every Monday: last week in numbers, for the Head Mod only */
async function modSummary(state, chans) {
  const ho = headOnlyKey(chans); if (!ho) return;
  const now = Date.now(), wk = L.dayKey(now), dow = new Date(new Date(now).toLocaleString("en-US", { timeZone: "America/Chicago" })).getDay();
  if (dow !== 1 || state.lastSummary === wk) return;
  const since = now - 7 * 864e5;
  const count = async (col, field = "at") => { const q = { structuredQuery: { from: [{ collectionId: col }], where: { fieldFilter: { field: { fieldPath: field }, op: "GREATER_THAN", value: { integerValue: String(since) } } }, limit: 1000 } };
    const rows = (await L.fs("POST", ":runQuery", q).catch(() => [])) || []; return rows.filter(r => r.document).map(r => L.fieldsOf(r.document)); };
  const [su, rp, fl, po, bans] = await Promise.all([count("signups"), count("reports"), count("flags"), count("posts"), count("bans")]);
  const why = {}; for (const r of rp) why[r.why || "?"] = (why[r.why || "?"] || 0) + 1;
  const users = Object.values(state.users), active = users.filter(u => u.last && Date.parse(u.last + "T12:00:00Z") > since).length;
  const fields = [
    { name: "🆕 New drivers", value: String(su.length), inline: true }, { name: "📝 Global posts", value: String(po.length), inline: true },
    { name: "🚩 Reports", value: rp.length ? `${rp.length}\n${Object.entries(why).map(([k, v]) => `${k}: ${v}`).join("\n").slice(0, 900)}` : "0", inline: true },
    { name: "⚠️ Suspicious offers", value: String(fl.length), inline: true }, { name: "⛔ New bans", value: String(bans.length), inline: true },
    { name: "💬 Discord chatters", value: `${active} active this week · ${users.length} tracked`, inline: true }];
  await L.discord("POST", `/channels/${ho.id}/messages`, { embeds: [{ title: "📊 Weekly mod summary", description: `Last 7 days, up to <t:${Math.floor(now / 1000)}:f>. Review reports in the app: Settings > Mod inbox.`, color: 0x9b7bff, fields }], allowed_mentions: { parse: [] } });
  state.lastSummary = wk; console.log("Weekly mod summary posted");
}

/* instant alerts: the app posts new drivers and suspicious activity straight to Discord through these webhooks.
   The bot makes them and stores their addresses in your database; it remakes them if one is ever deleted. */
async function hooks(state, chans) {
  const want = [["signup", "new-drivers"], ["sus", "head-only"]], out = {};
  for (const [k, ch] of want) {
    const c = ch === "head-only" ? headOnlyKey(chans) : L.findChan(chans, ch); if (!c) continue;
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
      { name: "Joined", value: `<t:${Math.floor((s.at || Date.now()) / 1000)}:f>`, inline: true }];
    await L.discord("POST", `/channels/${ch.id}/messages`, { embeds: [{ title: "🆕 New DasherDex driver", color: 0x5f8dff, fields, footer: { text: "Mods only." } }], allowed_mentions: { parse: [] } });
    const ho = headOnlyKey(chans);
    if (ho) await L.discord("POST", `/channels/${ho.id}/messages`, { embeds: [{ title: "📧 New driver's Gmail", color: 0x5f8dff, fields: [{ name: "Username", value: "@" + (s.username || user.username || "?"), inline: true }, { name: "Gmail", value: s.email || "?", inline: true }, { name: "Google name", value: String(s.name || user.name || "?").slice(0, 60), inline: true }], footer: { text: "Head Mod only." } }], allowed_mentions: { parse: [] } }).catch(() => {});
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
  try { await headUser(state, roles); } catch (e) { console.error("Head Mod: " + e.message); }
  try { await modSummary(state, chans); } catch (e) { console.error("Mod summary: " + e.message); }
  await levels(state, chans, roles);
  try { await activityRoles(state, roles); } catch (e) { console.error("Activity roles: " + e.message); }
  await leaderboard(state, chans);
  await saveState(state);
  console.log("Done.");
})().catch(e => { console.error(e.message); process.exit(1); });
