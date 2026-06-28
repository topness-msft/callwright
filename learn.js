// Learning loop CLI — enrich a scenario profile (or stage a candidate for a NEW
// profile) from a completed call. Thin wrapper over learn-core.js.
//
//   node learn.js <call_id> <call_type>
//
// Env: RETELL_API_KEY

const fs = require("fs");
const { PROFILES_PATH, CANDIDATES_PATH } = require("./paths");
const L = require("./learn-core");

const API_KEY = process.env.RETELL_API_KEY;
if (!API_KEY) { console.error("Missing RETELL_API_KEY."); process.exit(1); }

const callId = process.argv[2];
const callType = (process.argv[3] || "").toLowerCase();
if (!callId || !callType) {
  console.error("Usage: node learn.js <call_id> <call_type>");
  process.exit(1);
}

function loadJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } }

async function getCall() {
  const r = await fetch(`https://api.retellai.com/v2/get-call/${callId}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!r.ok) throw new Error(`get-call -> ${r.status}\n${await r.text()}`);
  return r.json();
}

(async () => {
  const call = await getCall();
  const gaps = L.detectGaps(call);

  if (!gaps.length) {
    console.log("No unanswered-question gaps detected in this call. Nothing to learn.");
    return;
  }
  console.log(`Detected ${gaps.length} gap(s) where the agent could not answer:`);
  gaps.forEach((g, i) => console.log(`  ${i + 1}. Business asked: "${g.question}"`));

  const profiles = loadJson(PROFILES_PATH, {});
  const profKey = L.matchProfile(profiles, callType);

  if (profKey) {
    const r = L.enrichProfile(profiles[profKey], gaps, callId);
    fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2) + "\n");
    console.log(`\nProfile "${profKey}" enriched (${r.added.length} new field(s): ${r.added.join(", ") || "none"}).`);
    return;
  }

  // No profile -> stage a candidate for possible NEW-profile creation (N>=2).
  const { general } = L.generalizeCallType(callType);
  const candidates = loadJson(CANDIDATES_PATH, {});
  const { candidate, ready } = L.stageCandidate(candidates, general, { callId, variant: callType, gaps }, 2);
  fs.writeFileSync(CANDIDATES_PATH, JSON.stringify(candidates, null, 2) + "\n");
  console.log(`\nNo profile matches "${callType}". Staged candidate "${general}" (seen ${candidate.count}x).`);
  if (ready) {
    const proposal = L.buildProposal(general, candidate, 2);
    console.log("READY for proposal:", JSON.stringify(proposal, null, 2));
  } else {
    console.log("Not yet promoted (needs to be seen >= 2 times).");
  }
})().catch((e) => { console.error("\nFailed:\n" + e.message); process.exit(1); });
