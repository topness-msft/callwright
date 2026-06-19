// Learning loop — enrich a scenario profile from a completed call.
// Detects moments where the agent could NOT answer (had to defer / follow up),
// extracts the business's question, maps it to a profile detail field, and adds
// it to recommended_details so future calls of this scenario collect it up front.
//
//   node learn.js <call_id> <call_type>
//
// Env: RETELL_API_KEY

const fs = require("fs");
const { PROFILES_PATH } = require("./paths");

const API_KEY = process.env.RETELL_API_KEY;
if (!API_KEY) { console.error("Missing RETELL_API_KEY."); process.exit(1); }

const callId = process.argv[2];
const callType = (process.argv[3] || "").toLowerCase();
if (!callId || !callType) {
  console.error("Usage: node learn.js <call_id> <call_type>");
  process.exit(1);
}

// Agent-uncertainty signals: the agent deferring instead of answering.
const DEFER_PATTERNS = [
  /i'?m not sure/i,
  /i'?ll check with/i,
  /i will check with/i,
  /follow up/i,
  /i don'?t (have|know)/i,
  /let me check with/i,
];

// Map a business question to a profile detail field (heuristic; an LLM can refine).
const QUESTION_TO_FIELD = [
  { rx: /(type|kind|style) of (haircut|cut|service)|what (type|kind|service)/i, key: "service_type", why: "Type of service requested" },
  { rx: /stylist|barber|who (will|would)|preferred (stylist|barber)/i, key: "stylist", why: "Preferred stylist/barber name" },
  { rx: /how long|length of (your |the )?hair|hair length/i, key: "hair_length", why: "Current/target hair length" },
  { rx: /new patient|been here before|existing patient|first (time|visit)/i, key: "new_or_existing", why: "New or existing patient" },
  { rx: /insurance|provider|carrier/i, key: "insurance", why: "Insurance provider" },
  { rx: /occasion|celebrat|birthday|anniversary/i, key: "occasion", why: "Special occasion, if any" },
  { rx: /allerg|dietary|gluten|vegan|vegetarian/i, key: "dietary_notes", why: "Dietary restrictions/allergies" },
  { rx: /address|location|where (are you|is it|do you live)|street|zip/i, key: "service_address", why: "Service/site address used to look up the appointment" },
  { rx: /phone number|number on (the |your )?account|contact number|callback/i, key: "account_phone", why: "Phone number on the account for lookup" },
];

async function getCall() {
  const r = await fetch(`https://api.retellai.com/v2/get-call/${callId}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!r.ok) throw new Error(`get-call -> ${r.status}\n${await r.text()}`);
  return r.json();
}

function parseTurns(transcript) {
  // transcript is "Agent: ...\nUser: ...\n" — split into ordered turns.
  const turns = [];
  for (const line of (transcript || "").split("\n")) {
    const m = line.match(/^(Agent|User):\s?(.*)$/);
    if (m) turns.push({ who: m[1], text: m[2] });
    else if (turns.length) turns[turns.length - 1].text += " " + line.trim();
  }
  return turns;
}

(async () => {
  const call = await getCall();
  const turns = parseTurns(call.transcript);
  const analysis = call.call_analysis || {};

  // Find agent turns where it deferred, and grab the preceding user question.
  const gaps = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.who !== "Agent") continue;
    if (!DEFER_PATTERNS.some((rx) => rx.test(t.text))) continue;
    // nearest preceding User turn = the question the agent couldn't answer
    let q = null;
    for (let j = i - 1; j >= 0; j--) { if (turns[j].who === "User") { q = turns[j].text; break; } }
    if (q) gaps.push({ question: q.trim(), agent: t.text.trim() });
  }
  // Also honor a structured field if the agent config captured it.
  if (analysis.custom_analysis_data?.unanswered_questions) {
    gaps.push({ question: analysis.custom_analysis_data.unanswered_questions, agent: "(post-call analysis)" });
  }

  if (!gaps.length) {
    console.log("No unanswered-question gaps detected in this call. Nothing to learn.");
    return;
  }

  console.log(`Detected ${gaps.length} gap(s) where the agent could not answer:`);
  gaps.forEach((g, i) => console.log(`  ${i + 1}. Business asked: "${g.question}"`));

  // Load profiles and enrich the matching one.
  const profiles = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8"));
  let profKey = Object.keys(profiles).find((name) => {
    const keys = [name, ...(profiles[name].aliases || [])].map((s) => s.toLowerCase());
    return keys.some((k) => callType === k || callType.includes(k) || k.includes(callType));
  });
  if (!profKey) {
    console.log(`\nNo profile matches "${callType}". Create one in scenario-profiles.json first.`);
    return;
  }
  const prof = profiles[profKey];
  prof.recommended_details = prof.recommended_details || {};
  prof.learned = prof.learned || [];

  let added = 0;
  for (const g of gaps) {
    const map = QUESTION_TO_FIELD.find((m) => m.rx.test(g.question));
    const key = map?.key;
    if (!key) {
      // capture raw for human/LLM promotion later
      prof.learned.push({ call_id: callId, question: g.question, mapped_field: null, at: new Date().toISOString() });
      console.log(`  • "${g.question}" -> (no auto-mapping; recorded for review)`);
      continue;
    }
    if (!prof.recommended_details[key]) {
      prof.recommended_details[key] = map.why;
      added++;
      console.log(`  ✅ Learned: added recommended detail "${key}" to profile "${profKey}"`);
    } else {
      console.log(`  • "${key}" already recommended in "${profKey}" — no change`);
    }
    prof.learned.push({ call_id: callId, question: g.question, mapped_field: key, at: new Date().toISOString() });
  }

  fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2) + "\n");
  console.log(`\nProfile "${profKey}" updated (${added} new recommended field(s)). Future ${profKey} calls will collect them up front.`);
})().catch((e) => { console.error("\nFailed:\n" + e.message); process.exit(1); });
