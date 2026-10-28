/* DasherDex Discord bot, quick jobs. GitHub runs this about every 10 minutes (free).
   1. 🌱 Newcomer: new members get it when they join, and lose it after a week.
   2. 🎭 pick-roles: react to get a role, remove the reaction to drop it.
   3. !card username (or /card username): shows that driver's best DasherDex card.
   4. Big pulls: Legendary and Mythic pulls drivers chose to share go to #big-pulls.
   Only inside your DasherDex server. Never DMs anyone. */
const L = require("./lib");
const STATE_DOC = "/discordbot/fast";
const PICK_ROLES = [["🚗", "🚗 DoorDash"], ["🍔", "🍔 Uber Eats"], ["🔔", "🔔 Update pings"], ["🇲🇽", "🇲🇽 Español"]];
const TIER = { mythic: ["Mythic", 0xff4d8d], legendary: ["Legendary", 0xf3c55a], epic: ["Epic", 0xa77bff], superrare: ["Super Rare", 0x41d6c3], rare: ["Rare", 0x5f8dff], uncommon: ["Uncommon", 0x3ddc84], common: ["Common", 0x9aa0ae], trash: ["Trash", 0x8a6a4a] };
const FIN = { holo: "✦ Holographic", gold: "✦ Gold Foil", neon: "✦ Neon", carbon: "✦ Carbon Fiber", inverted: "✦ Inverted" };
const WEEK = 7 * 864e5;

async function loadState() { const d = await L.fs("GET", STATE_DOC); let s = {}; try { s = JSON.parse(L.fieldsOf(d).json || "{}"); } catch (e) {} return { after: {}, newbies: {}, rr: {}, ...s }; }
async function saveState(s) { await L.fs("PATCH", STATE_DOC, { fields: { json: { stringValue: JSON.stringify(s) }, at: { integerValue: String(Date.now()) } } }); }
const roleBy = (roles, name) => roles.find(r => L.nounOf(r.name) === L.nounOf(name));
const money = n => "$" + (+n || 0).toFixed(2);

/* read new messages in the community channels: join messages (Newcomer) and !card commands */
async function messages(state, chans, roles) {
  const cat = chans.find(c => c.type === 4 && L.keyOf(c.name) === "community");
  const list = chans.filter(c => (c.type === 0 || c.type === 5) && cat && c.parent_id === cat.id && L.keyOf(c.name) !== "leaderboard");
  const since = L.snowflakeAt(Date.now() - 30 * 60e3), newbie = roleBy(roles, "Newcomer");
  let cards = 0, joins = 0;
  for (const ch of list) {
    const batch = await L.discord("GET", `/channels/${ch.id}/messages?limit=50&after=${state.after[ch.id] || since}`).catch(() => []);
    if (!batch.length) continue;
    state.after[ch.id] = batch.map(m => m.id).sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1))[0];
    for (const m of batch.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))) {
      if (m.type === 7 && m.author && !m.author.bot) {          // "X joined the server"
        if (newbie && !state.newbies[m.author.id]) { await L.discord("PUT", `/guilds/${L.GUILD}/members/${m.author.id}/roles/${newbie.id}`).catch(() => {}); state.newbies[m.author.id] = Date.parse(m.timestamp) || Date.now(); joins++; }
        continue;
      }
      if (m.author && m.author.bot) continue;
      const cmd = String(m.content || "").match(/^\s*[!/]card\b\s*@?([A-Za-z0-9_.]{0,20})/i);
      if (cmd && Date.now() - (Date.parse(m.timestamp) || 0) < 30 * 60e3) { await cardReply(ch, m, cmd[1]).catch(e => console.warn("card: " + e.message)); cards++; }
    }
  }
  // Newcomer lasts one week
  for (const [id, t] of Object.entries(state.newbies)) if (Date.now() - t > WEEK) {
    if (newbie) await L.discord("DELETE", `/guilds/${L.GUILD}/members/${id}/roles/${newbie.id}`).catch(() => {});
    delete state.newbies[id];
  }
  console.log(`Messages: ${joins} new members, ${cards} card lookups`);
}

/* !card username */
async function cardReply(ch, m, name) {
  const reply = body => L.discord("POST", `/channels/${ch.id}/messages`, { ...body, message_reference: { message_id: m.id, fail_if_not_exists: false }, allowed_mentions: { parse: [], replied_user: false } });
  if (!name) return reply({ content: "Type `!card` and a DasherDex username, like `!card speedydasher`." });
  const key = name.toLowerCase();
  const u = L.fieldsOf(await L.fs("GET", "/usernames/" + encodeURIComponent(key)));
  if (!u.uid) return reply({ content: `No DasherDex driver called **@${key}**. Check the spelling (it's their app username).` });
  const pub = await L.fs("GET", "/pub/" + u.uid);
  const best = pub && pub.fields && pub.fields.best && pub.fields.best.mapValue ? L.fieldsOf(pub.fields.best.mapValue) : null;
  const p = L.fieldsOf(pub);
  if (!best || !best.tier) return reply({ content: `**@${key}** hasn't synced a best card yet.` });
  const [tn, col] = TIER[best.tier] || ["?", 0x888888];
  const fields = [{ name: "Rarity", value: `${tn} · ${best.score}`, inline: true }];
  if (best.finish && best.finish !== "standard") fields.push({ name: "Frame", value: FIN[best.finish] || best.finish, inline: true });
  fields.push({ name: "Driver", value: `@${key}${p.level ? ` · Level ${p.level}` : ""}${p.title ? ` · ${String(p.title).slice(0, 30)}` : ""}`, inline: false });
  return reply({ embeds: [{ title: `🃏 ${String(best.store || "Mystery order").slice(0, 60)}`, description: `@${key}'s best DasherDex card`, color: col, fields, footer: { text: "Get yours at dasherdex.web.app" } }] });
}

/* pick-roles: keep the roles in step with the reactions */
async function pickRoles(state, roles) {
  const bs = L.fieldsOf(await L.fs("GET", "/discordbot/state")); let main = {}; try { main = JSON.parse(bs.json || "{}"); } catch (e) {}
  if (!main.pickMsg || !main.pickCh) return;
  let changed = 0;
  for (const [emoji, name] of PICK_ROLES) {
    const role = roleBy(roles, name); if (!role) continue;
    const now = new Set(); let after = "0";
    for (let page = 0; page < 10; page++) {
      const users = await L.discord("GET", `/channels/${main.pickCh}/messages/${main.pickMsg}/reactions/${encodeURIComponent(emoji)}?limit=100&after=${after}`).catch(() => []);
      for (const u of users) if (!u.bot) now.add(u.id);
      if (users.length < 100) break; after = users[users.length - 1].id;
    }
    const had = new Set(state.rr[emoji] || []);
    for (const id of now) if (!had.has(id)) { await L.discord("PUT", `/guilds/${L.GUILD}/members/${id}/roles/${role.id}`).catch(() => {}); changed++; }
    for (const id of had) if (!now.has(id)) { await L.discord("DELETE", `/guilds/${L.GUILD}/members/${id}/roles/${role.id}`).catch(() => {}); changed++; }
    state.rr[emoji] = [...now];
  }
  console.log(`Pick roles: ${changed} changes`);
}

/* Legendary and Mythic pulls from the app (drivers who turned it on in Settings) */
async function bigPulls(chans) {
  const ch = L.findChan(chans, "big-pulls") || L.findChan(chans, "best-pulls"); if (!ch) return;
  const rows = (await L.fs("POST", ":runQuery", { structuredQuery: { from: [{ collectionId: "bigpulls" }], limit: 15 } })) || [];
  let n = 0;
  for (const row of rows) {
    if (!row.document) continue;
    const d = L.fieldsOf(row.document), card = row.document.fields.card && row.document.fields.card.mapValue ? L.fieldsOf(row.document.fields.card.mapValue) : null;
    const path = row.document.name.split("/documents")[1];
    if (card && TIER[card.tier] && Date.now() - (d.at || 0) < 2 * 864e5) {
      const [tn, col] = TIER[card.tier];
      const fields = [{ name: "Payout", value: money(card.pay), inline: true }, { name: "Per hour", value: money(card.pph), inline: true }, { name: "Per mile", value: money(card.ppm), inline: true },
        { name: "Trip", value: `${card.miles || "?"} mi · ${card.minutes || "?"} min`, inline: true }, { name: "Rarity", value: `${tn} · ${card.score}`, inline: true }];
      if (card.finish && card.finish !== "standard") fields.push({ name: "Frame", value: FIN[card.finish] || card.finish, inline: true });
      await L.discord("POST", `/channels/${ch.id}/messages`, { embeds: [{ title: `${card.tier === "mythic" ? "🌈" : "👑"} ${tn} pull: ${String(card.store || "").slice(0, 60)}`, description: `Pulled by **${String(d.name || "a driver").slice(0, 24)}**${card.platform ? ` on ${card.platform}` : ""}`, color: col, fields, footer: { text: "Shared from DasherDex · dasherdex.web.app" } }], allowed_mentions: { parse: [] } });
      n++;
    }
    await L.fs("DELETE", path).catch(() => {});
  }
  console.log(`Big pulls posted: ${n}`);
}

(async () => {
  L.need(); await L.checkGuild();
  const state = await loadState();
  const [chans, roles] = await Promise.all([L.channels(), L.discord("GET", `/guilds/${L.GUILD}/roles`)]);
  try { await messages(state, chans, roles); } catch (e) { console.error("Messages: " + e.message); }
  try { await pickRoles(state, roles); } catch (e) { console.error("Pick roles: " + e.message); }
  try { await bigPulls(chans); } catch (e) { console.error("Big pulls: " + e.message); }
  await saveState(state);
  console.log("Done.");
})().catch(e => { console.error(e.message); process.exit(1); });
