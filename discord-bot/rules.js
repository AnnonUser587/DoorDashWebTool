/* Publishes firestore.rules to your Firebase project (no Firebase tools needed).
   Firebase checks the rules first: if there's a mistake, nothing changes and the exact line is printed. */
const L = require("./lib");
const fs = require("fs");
const API = process.env.RULES_API || "https://firebaserules.googleapis.com/v1";
(async () => {
  const sa = L.serviceAccount(), project = process.env.FIREBASE_PROJECT || sa.project_id;
  const content = fs.readFileSync("firestore.rules", "utf8");
  const tok = await L.gToken("https://www.googleapis.com/auth/cloud-platform");
  const call = async (method, path, body) => {
    const r = await fetch(API + path, { method, headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j.error && j.error.message) || JSON.stringify(j).slice(0, 500);
      if (r.status === 403) throw new Error(`The service account (${sa.client_email}) isn't allowed to publish rules. In Google Cloud > IAM, give it the role "Firebase Rules Admin". Details: ${msg}`);
      throw new Error(`Firebase said ${r.status}: ${msg}`);
    }
    return j;
  };
  console.log("Checking and uploading the rules...");
  let rs;
  try { rs = await call("POST", `/projects/${project}/rulesets`, { source: { files: [{ name: "firestore.rules", content }] } }); }
  catch (e) { console.error("The rules were NOT published. " + e.message); process.exit(1); }
  console.log("Rules check passed: " + rs.name);
  const rel = { name: `projects/${project}/releases/cloud.firestore`, rulesetName: rs.name };
  try { await call("PATCH", `/projects/${project}/releases/cloud.firestore`, { release: rel }); }
  catch (e) { if (/404|NOT_FOUND/i.test(e.message)) await call("POST", `/projects/${project}/releases`, rel); else throw e; }
  console.log("Published! Your Firestore rules are live.");
})().catch(e => { console.error(e.message); process.exit(1); });
