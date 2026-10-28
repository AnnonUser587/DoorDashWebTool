/* Posts a short summary to the patch-notes channel when index.html changes on GitHub.
   New version number: the "What's new" list from the app. Same version: a short "small fixes" note.
   Add [no notes] to a commit message to skip posting. */
const L = require("./lib");
const fsys = require("fs"), vm = require("vm"), { execSync } = require("child_process");
function info(html) {
  if (!html) return null;
  const ver = (html.match(/const APP_VER="([^"]+)"/) || [])[1];
  const raw = (html.match(/const WHATS_NEW=(\[[\s\S]*?\n\]);/) || [])[1];
  let notes = []; try { notes = vm.runInNewContext(raw, {}, { timeout: 500 }); } catch (e) {}
  return ver ? { ver, notes } : null;
}
(async () => {
  L.need();
  const msg = process.env.COMMIT_MSG || "";
  if (/\[no notes\]/i.test(msg)) { console.log("Skipped: [no notes]"); return; }
  const now = info(fsys.readFileSync("index.html", "utf8"));
  if (!now) { console.log("No APP_VER in index.html; nothing to post."); return; }
  let before = null; try { before = info(execSync("git show HEAD~1:index.html", { maxBuffer: 50e6 }).toString()); } catch (e) {}
  await L.checkGuild();
  const ch = L.findChan(await L.channels(), "patch-notes");
  if (!ch) throw new Error("No patch-notes channel in the server.");
  let embed;
  if (!before || before.ver !== now.ver) {
    const entry = (now.notes || []).find(e => e[0] === now.ver) || (now.notes || [])[0] || [now.ver, "", []];
    const items = (entry[2] || []).slice(0, 16).map(x => "• " + x).join("\n");
    embed = { title: `🛠️ DasherDex ${now.ver} is out!`, url: "https://dasherdex.web.app", color: 0xf3c55a,
      description: (items || "Improvements and fixes.") + "\n\n**Get it:** close DasherDex and open it again.", footer: { text: "dasherdex.web.app" }, timestamp: new Date().toISOString() };
  } else {
    embed = { title: `🔧 Small update (v${now.ver})`, url: "https://dasherdex.web.app", color: 0x4cc9a6,
      description: "Bug fixes and polish. Close DasherDex and open it again to get it.", timestamp: new Date().toISOString() };
  }
  // new versions ping the people who picked 🔔 Update pings
  let ping = null;
  if (!before || before.ver !== now.ver) { try { const roles = await L.discord("GET", `/guilds/${L.GUILD}/roles`); ping = roles.find(r => L.nounOf(r.name) === "update pings") || null; } catch (e) {} }
  await L.discord("POST", `/channels/${ch.id}/messages`, { content: ping ? `<@&${ping.id}>` : undefined, embeds: [embed], allowed_mentions: { parse: [], roles: ping ? [ping.id] : [] } });
  console.log("Posted: " + embed.title);
})().catch(e => { console.error(e.message); process.exit(1); });
