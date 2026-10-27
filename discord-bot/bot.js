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
  try { await newDrivers(state, chans); } catch (e) { console.error("New drivers: " + e.message); }
  await levels(state, chans, roles);
  await leaderboard(state, chans);
  await saveState(state);
  console.log("Done.");
})().catch(e => { console.error(e.message); process.exit(1); });
