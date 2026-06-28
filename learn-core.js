// callwright — learning core (enrich existing scenario profiles AND stage
// candidates for NEW profiles). Deterministic heuristics only; the JUDGMENT
// calls the spec reserves for an LLM (canonicalize merge-vs-create,
// propose-and-confirm) happen in the MCP layer / host LLM, not here.
//
// The one invariant (docs/profile-learning-spec.md): a profile stores SCHEMA
// (field keys), never VALUES. Every guard here serves that invariant.

// ---- agent-uncertainty signals (the agent deferring instead of answering) ----
const DEFER_PATTERNS = [
  /i'?m not sure/i, /i'?ll check with/i, /i will check with/i, /follow up/i,
  /i don'?t (have|know)/i, /let me check with/i,
];

// Map a business question to a GENERALIZED profile field (heuristic; LLM refines).
const QUESTION_TO_FIELD = [
  { rx: /(type|kind|style) of (haircut|cut|service)|what (type|kind|service)/i, key: "service_type", why: "Type of service requested" },
  { rx: /stylist|barber|who (will|would)|preferred (stylist|barber)/i, key: "stylist", why: "Preferred stylist/barber name" },
  { rx: /how long|length of (your |the )?hair|hair length/i, key: "hair_length", why: "Current/target hair length" },
  { rx: /new patient|been here before|existing patient|first (time|visit)/i, key: "new_or_existing", why: "New or existing patient" },
  { rx: /insurance|provider|carrier/i, key: "insurance", why: "Insurance provider" },
  { rx: /occasion|celebrat|birthday|anniversary/i, key: "occasion", why: "Special occasion, if any" },
  { rx: /allerg|dietary|gluten|vegan|vegetarian/i, key: "dietary_notes", why: "Dietary restrictions/allergies" },
  { rx: /destination|where (to|are you going)|drop.?off|going to/i, key: "destination", why: "Drop-off destination" },
  { rx: /pick.?up (time|when)|what time.*pick|when.*pick.?up/i, key: "pickup_time", why: "Requested pickup time" },
  { rx: /how many (people|passengers|in your party)|party size|number of (people|guests)/i, key: "party_size", why: "Number of people" },
  { rx: /how (much )?luggage|how many (bags|suitcases)|baggage/i, key: "luggage", why: "Amount of luggage" },
  { rx: /address|location|where (is it|do you live)|street|zip/i, key: "service_address", why: "Service/site address used to look up the appointment" },
  { rx: /phone number|number on (the |your )?account|contact number|callback/i, key: "account_phone", why: "Phone number on the account for lookup" },
];

const WEEKDAYS = new Set(["monday","tuesday","wednesday","thursday","friday","saturday","sunday","mon","tue","wed","thu","fri","sat","sun"]);
const MONTHS = new Set(["january","february","march","april","may","june","july","august","september","october","november","december","jan","feb","mar","apr","jun","jul","aug","sep","sept","oct","nov","dec"]);
const CONNECTORS = new Set(["to","for","with","at","in","on","near","by","from","of"]);
// Generic scenario tail-words that must NOT be stripped even after a connector.
const KEEP_TAIL = new Set(["inquiry","reservation","booking","confirmation","appointment","service","request","call"]);

// #1: reduce an instance-shaped call_type to its general scenario form.
function generalizeCallType(callType) {
  const raw = String(callType || "").toLowerCase().trim();
  let tokens = raw.split(/[\s_\-]+/).filter(Boolean);
  const stripped = [];
  // Cut at the first connector preposition (e.g. "..._to_haneda") UNLESS what
  // follows is a generic scenario word (e.g. "type_of_service").
  const ci = tokens.findIndex((t, i) => i > 0 && CONNECTORS.has(t));
  if (ci > 0) {
    const tail = tokens.slice(ci + 1);
    if (!tail.some((t) => KEEP_TAIL.has(t))) {
      stripped.push(...tokens.slice(ci));
      tokens = tokens.slice(0, ci);
    }
  }
  // Drop pure numbers, dates, weekdays, months (instance values).
  tokens = tokens.filter((t) => {
    if (/^\d+$/.test(t) || /^\d{4}-\d{2}-\d{2}$/.test(t) || WEEKDAYS.has(t) || MONTHS.has(t)) { stripped.push(t); return false; }
    return true;
  });
  const general = tokens.join("_");
  return { general: general || raw, stripped, changed: stripped.length > 0 };
}

// #3: a "field" whose key/description bakes in a specific value is a value in
// disguise — reject it from the profile (it belongs in the per-call job).
function looksInstanceValued(key, description = "") {
  const k = String(key || "");
  const d = String(description || "");
  if (/\d/.test(k)) return true;                                   // digits in a field key
  if (/\d{4}-\d{2}-\d{2}/.test(d)) return true;                    // a date
  if (/["'].+["']/.test(d)) return true;                          // a quoted literal
  const segs = k.toLowerCase().split(/[_\-]+/).filter(Boolean);
  // A generalized field is a short generic noun; >3 segments usually = value-baked.
  if (segs.length > 3) return true;
  // Trailing proper-noun-ish segment after a known generic head (destination_haneda).
  const GENERIC_HEADS = new Set(["destination","party","date","time","name","stylist","location","address","city","airport"]);
  if (segs.length >= 2 && GENERIC_HEADS.has(segs[0]) && !["size","type","range","window","preference","notes","time"].includes(segs[segs.length - 1])) {
    return true;
  }
  return false;
}

function mapQuestionToField(question) {
  return QUESTION_TO_FIELD.find((m) => m.rx.test(String(question || ""))) || null;
}

function parseTurns(transcript) {
  const turns = [];
  for (const line of String(transcript || "").split("\n")) {
    const m = line.match(/^(Agent|User):\s?(.*)$/);
    if (m) turns.push({ who: m[1], text: m[2] });
    else if (turns.length) turns[turns.length - 1].text += " " + line.trim();
  }
  return turns;
}

// Detect moments the agent could not answer (deferred) + structured unanswered.
function detectGaps(call) {
  const turns = parseTurns(call && call.transcript);
  const gaps = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.who !== "Agent" || !DEFER_PATTERNS.some((rx) => rx.test(t.text))) continue;
    let q = null;
    for (let j = i - 1; j >= 0; j--) { if (turns[j].who === "User") { q = turns[j].text; break; } }
    if (q) gaps.push({ question: q.trim(), agent: t.text.trim() });
  }
  const ua = call && call.call_analysis && call.call_analysis.custom_analysis_data
    && call.call_analysis.custom_analysis_data.unanswered_questions;
  if (ua && String(ua).trim()) gaps.push({ question: String(ua).trim(), agent: "(post-call analysis)" });
  return gaps;
}

// #2 (first pass): existing fuzzy name/alias match.
function matchProfile(profiles, callType) {
  const ct = String(callType || "").toLowerCase();
  for (const [name, p] of Object.entries(profiles || {})) {
    const keys = [name, ...((p && p.aliases) || [])].map((s) => s.toLowerCase());
    if (keys.some((k) => ct === k || ct.includes(k) || k.includes(ct))) return name;
  }
  return null;
}

// Enrich an existing profile from gaps. value-rejection guard (#3) applied.
// minCount (#4/#5): only PROMOTE a field to recommended_details once it has been
// seen >= minCount times (across this profile's learned history + this call).
// minCount=1 = promote on first sight (explicit/manual use); minCount>=2 =
// noise-guard for autonomous/webhook use. Idempotent: a call_id already in the
// learned log is skipped so a webhook redelivery can't double-count.
function enrichProfile(profile, gaps, callId, { minCount = 1 } = {}) {
  profile.recommended_details = profile.recommended_details || {};
  profile.learned = profile.learned || [];
  if (callId && profile.learned.some((e) => e.call_id === callId)) {
    return { added: [], skipped: true };
  }
  // Prior occurrence counts from history.
  const counts = {};
  for (const e of profile.learned) if (e.mapped_field) counts[e.mapped_field] = (counts[e.mapped_field] || 0) + 1;
  const added = [];
  for (const g of gaps || []) {
    const map = mapQuestionToField(g.question);
    const key = map && map.key;
    if (!key) {
      profile.learned.push({ call_id: callId, question: g.question, mapped_field: null, at: new Date().toISOString() });
      continue;
    }
    if (looksInstanceValued(key, map.why)) {
      profile.learned.push({ call_id: callId, question: g.question, mapped_field: null, rejected: "instance_valued", at: new Date().toISOString() });
      continue;
    }
    profile.learned.push({ call_id: callId, question: g.question, mapped_field: key, at: new Date().toISOString() });
    counts[key] = (counts[key] || 0) + 1;
    if (!profile.recommended_details[key] && counts[key] >= minCount) {
      profile.recommended_details[key] = map.why;
      added.push(key);
    }
  }
  return { added };
}

// #4: stage an unmatched (generalized) call_type; promote at N occurrences.
function stageCandidate(store, generalType, { callId, variant, gaps } = {}, N = 2) {
  const now = new Date().toISOString();
  const c = store[generalType] || { count: 0, examples: [], variants: [], questions: {}, first_seen: now, last_seen: now, proposed: false };
  const isNewCall = callId && !c.examples.includes(callId);
  if (isNewCall) { c.count += 1; c.examples.push(callId); }
  if (variant && !c.variants.includes(variant)) c.variants.push(variant);
  for (const g of gaps || []) {
    const map = mapQuestionToField(g.question);
    const fkey = map && map.key ? map.key : ("q:" + slug(g.question));
    const why = map && map.why ? map.why : g.question;
    const q = c.questions[fkey] || { count: 0, why, mapped: !!(map && map.key), examples: [] };
    // only count once per call for a given field
    if (isNewCall) q.count += 1;
    if (q.examples.length < 3 && !q.examples.includes(g.question)) q.examples.push(g.question);
    c.questions[fkey] = q;
  }
  c.last_seen = now;
  store[generalType] = c;
  return { candidate: c, ready: c.count >= N && !c.proposed };
}

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

// Build a propose-and-confirm proposal from a ready candidate.
function buildProposal(generalType, candidate, N = 2) {
  const recommended = {};
  const weak = {};
  for (const [fkey, q] of Object.entries((candidate && candidate.questions) || {})) {
    if (fkey.startsWith("q:") || !q.mapped) { weak[fkey] = q.why; continue; }     // unmapped -> weak suggestion
    if (q.count >= N && !looksInstanceValued(fkey, q.why)) recommended[fkey] = q.why;
    else weak[fkey] = q.why;
  }
  const aliases = ((candidate && candidate.variants) || []).filter((v) => v && v !== generalType);
  return {
    name: generalType,
    aliases,
    recommended_details: recommended,
    weak_candidates: weak,
    seen: (candidate && candidate.count) || 0,
    examples: (candidate && candidate.examples) || [],
  };
}

// #1 + collision: validate a proposed NEW profile before creation.
function validateNewProfile(name, profiles = {}, recommended_details = {}) {
  const errors = [];
  const n = String(name || "").toLowerCase().trim();
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(n)) errors.push(`Invalid profile name "${name}" (use snake_case, no spaces/values).`);
  const gen = generalizeCallType(n);
  if (gen.changed) errors.push(`"${name}" looks instance-shaped (embeds ${gen.stripped.join(", ")}). Use the general form "${gen.general}" and route the specific part into the per-call job.`);
  // collision: name or alias already exists
  let collision = null;
  for (const [pname, p] of Object.entries(profiles || {})) {
    const keys = [pname, ...((p && p.aliases) || [])].map((s) => s.toLowerCase());
    if (keys.includes(n)) { collision = pname; break; }
  }
  for (const [k, why] of Object.entries(recommended_details || {})) {
    if (looksInstanceValued(k, why)) errors.push(`recommended_details key "${k}" looks value-baked; use a generalized field name.`);
  }
  return { ok: errors.length === 0 && !collision, errors, collision };
}

// Shared orchestrator used by BOTH the MCP learn_from_call tool and the webhook
// auto-learn path. Mutates the passed profiles/candidates; the caller persists.
// callType comes from the arg or the call's round-tripped dynamic variable.
function applyLearning(call, { profiles, candidates, callType, minCount = 1, N = 2 } = {}) {
  const ct = String(
    callType || (call && call.retell_llm_dynamic_variables && call.retell_llm_dynamic_variables.call_type) || ""
  ).toLowerCase();
  const callId = call && call.call_id;
  const gaps = detectGaps(call);
  if (!ct) return { mode: "skip", reason: "no_call_type", gaps: gaps.map((g) => g.question) };
  if (!gaps.length) return { mode: "skip", reason: "no_gaps", call_type: ct };

  const profKey = matchProfile(profiles || {}, ct);
  if (profKey) {
    const r = enrichProfile(profiles[profKey], gaps, callId, { minCount });
    return { mode: "enriched", profile: profKey, added: r.added || [], skipped: r.skipped || false, gaps: gaps.map((g) => g.question) };
  }
  const { general, changed, stripped } = generalizeCallType(ct);
  const { candidate, ready } = stageCandidate(candidates || {}, general, { callId, variant: ct, gaps }, N);
  const out = {
    mode: "staged", scenario: general,
    generalized_from: changed ? { original: ct, stripped } : undefined,
    seen: candidate.count, ready_to_propose: ready, gaps: gaps.map((g) => g.question),
  };
  if (ready) out.proposal = buildProposal(general, candidate, N);
  return out;
}

module.exports = {
  DEFER_PATTERNS, QUESTION_TO_FIELD,
  generalizeCallType, looksInstanceValued, mapQuestionToField,
  parseTurns, detectGaps, matchProfile, enrichProfile,
  stageCandidate, buildProposal, validateNewProfile, slug, applyLearning,
};
