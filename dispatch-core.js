// callwright — dispatch core (reusable, no CLI / no process.argv).
//
// The validate -> profile-match -> compose-vars -> resolve-agent -> dispatch
// pipeline, callable in-process by BOTH the CLI (dispatch.js) and the MCP
// server. Pure of stdin/stdout side effects except where noted (buildReadback
// returns text; it does not print).

const fs = require("fs");
const Ajv = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const paths = require("./paths");

const SCHEMA_PATH = "place_call.schema.json";
const PROFILES_PATH = paths.PROFILES_PATH;
const CONFIG_PATH = paths.CONFIG_PATH;
const AGENTS_PATH = paths.AGENTS_PATH;
const RETELL_BASE = "https://api.retellai.com";

function loadJson(p, fb) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; }
}
function loadConfig() { return loadJson(CONFIG_PATH, {}); }

// Backfill ONLY the always-safe basics from config (identity + callback). Facts
// are NOT auto-merged (data minimization: caller furnishes a per-call subset).
// A job may set principal.anonymous=true to opt out entirely (general inquiries).
function applyConfigBackfill(job, config = loadConfig()) {
  const anon = job.principal && job.principal.anonymous === true;
  if (config.principal && !anon) {
    const cp = config.principal;
    job.principal = job.principal || {};
    if (job.principal.name == null) job.principal.name = cp.name;
    if (job.principal.callback_number == null && cp.callback_number != null)
      job.principal.callback_number = cp.callback_number;
  }
  return job;
}

let _validate = null;
function validateJob(job) {
  if (!_validate) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    _validate = ajv.compile(loadJson(SCHEMA_PATH, {}));
  }
  const ok = _validate(job);
  return {
    ok,
    errors: ok ? [] : _validate.errors.map((e) => `${e.instancePath || "(root)"} ${e.message}`),
  };
}

// Match an open-ended call_type to a scenario profile (name or alias, fuzzy).
function loadProfileFor(callType) {
  const profiles = loadJson(PROFILES_PATH, null);
  if (!profiles) return null;
  const ct = (callType || "").toLowerCase();
  for (const [name, p] of Object.entries(profiles)) {
    const keys = [name, ...(p.aliases || [])].map((s) => s.toLowerCase());
    if (keys.some((k) => ct === k || ct.includes(k) || k.includes(ct))) return { name, ...p };
  }
  return null;
}

// ---- formatting ----
function prettyDate(iso) {
  const d = new Date(iso + "T12:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}
function pretty12h(t) {
  const [h, m] = t.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
}
function deriveWindows(req, flexMin) {
  if (req.acceptable_windows && req.acceptable_windows.length) return req.acceptable_windows;
  if (!req.preferred?.date || !req.preferred?.time) {
    throw new Error("No acceptable_windows and no preferred date/time to derive from.");
  }
  const [h, m] = req.preferred.time.split(":").map(Number);
  const base = h * 60 + m;
  const fmt = (mins) => {
    const hh = Math.floor((((mins % 1440) + 1440) % 1440) / 60);
    const mm = ((mins % 60) + 60) % 60;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  };
  return [{ date: req.preferred.date, earliest: fmt(base - flexMin), latest: fmt(base + flexMin) }];
}

// Compose the rich job -> Retell dynamic variables + call metadata.
// `lang` selects the language of COMPOSED helper strings (en | ja).
function composeCall(job, { lang = "en" } = {}) {
  const LANG = String(lang || "en").toLowerCase();
  const isJa = LANG === "ja" || LANG === "ja-jp";
  const profile = loadProfileFor(job.call_type);

  const flex = job.overrides?.time_flexibility_minutes ?? profile?.default_flex_minutes ?? 45;
  const windows = deriveWindows(job.request, flex);
  const windowsStr = windows
    .map((w, i) => `${i + 1}) ${prettyDate(w.date)}, ${pretty12h(w.earliest)}-${pretty12h(w.latest)}`)
    .join("   ");

  const details = job.scenario_details || {};
  const facts = (job.principal && job.principal.facts) || {};
  const missingRecommended = [];
  if (profile?.recommended_details) {
    for (const [key, why] of Object.entries(profile.recommended_details)) {
      const present =
        (details[key] != null && details[key] !== "") ||
        (facts[key] != null && facts[key] !== "") ||
        (key === "party_size" && job.request.party_size);
      if (!present) missingRecommended.push({ key, why });
    }
  }
  const detailSentences = Object.entries(details).map(([k, v]) => {
    const label = k.replace(/_/g, " ");
    return `${label.charAt(0).toUpperCase() + label.slice(1)}: ${v}.`;
  });

  const principalName = (job.principal && job.principal.name) ? String(job.principal.name).trim() : "";
  const hasName = principalName.length > 0;
  const onBehalf = hasName ? ` on behalf of ${principalName}` : "";
  const principalRef = hasName ? principalName : (isJa ? "依頼主" : "the person I'm assisting");

  const objective = job.request.summary;
  const serviceType = details.service_type ? ` (${details.service_type})` : "";
  const objectiveDetail = job.request.party_size
    ? `${job.request.summary}${serviceType} (party of ${job.request.party_size}).`
    : `${job.request.summary}${serviceType}.`;

  // The spoken purpose line. PREFER an explicit, call-language opening_ask that the
  // host LLM authored (it writes fluent, natural sentences). Only fall back to a
  // simple derivation from summary when opening_ask is absent — no fragile
  // sentence-shape detection; just a plain, safe wrapper.
  const deriveOpeningAsk = (summary) => {
    const s = String(summary || "").trim().replace(/[.?!。、]+$/, "");
    if (isJa) return `${s}についてお伺いしたく、お電話いたしました。少々よろしいでしょうか。`;
    const lc = s.charAt(0).toLowerCase() + s.slice(1);
    return `I'm calling about ${lc}. Could you help me with that?`;
  };
  const openingAsk = job.request.opening_ask || deriveOpeningAsk(job.request.summary);

  const deriveVoicemail = (summary, behalf, callback) => {
    const s = String(summary || "").trim().replace(/[.?!。、]+$/, "");
    if (isJa) {
      const cb = callback ? `${callback}までご連絡ください。` : "ご都合のよいときにご連絡ください。";
      return `お世話になっております。AIアシスタントでございます。${s}の件でお電話いたしました。${cb}よろしくお願いいたします。`;
    }
    const lc = s.charAt(0).toLowerCase() + s.slice(1);
    const cb = callback ? ` Please call back at ${callback}.` : " Please call back at your convenience.";
    return `Hi, this is an AI assistant calling${behalf}. I'm calling to ${lc}.${cb} Thank you.`;
  };
  const voicemailMessage = deriveVoicemail(job.request.summary, onBehalf, job.principal && job.principal.callback_number);

  const composeKnownFacts = (f) => {
    const entries = Object.entries(f || {}).filter(([, v]) => v != null && v !== "");
    if (!entries.length) return isJa ? "（特になし）" : "None on file.";
    return entries
      .map(([k, v]) => `- ${k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}: ${v}`)
      .join("\n");
  };
  const knownFacts = composeKnownFacts(facts);

  const bookingNameLine = hasName
    ? (isJa
        ? `予約になる場合、または先方に「どちら様のお名前で？」と尋ねられた場合は、**${principalName}**とお伝えください。それ以前に名前を名乗らないでください。`
        : `If this becomes a booking, or the business asks what name it's under, use **${principalName}**. Do not state the name before then.`)
    : (isJa
        ? `これは一般的なお問い合わせです。名前や予約は関係ありません。名前を伝えたり作ったりしないでください。`
        : `This is a general inquiry — no name or booking is involved. Do not give or invent a name.`);

  const confirmParts = ["the date", "the time"];
  if (job.request.party_size) confirmParts.splice(2, 0, "the party size");
  const mustConfirm = (job.must_confirm && job.must_confirm.length)
    ? job.must_confirm.join(", ")
    : (profile?.must_confirm ? profile.must_confirm.join(", ") : (isJa ? "日付、時間" : confirmParts.join(", ")));

  const baseConstraints = (job.constraints && job.constraints.length) ? job.constraints.slice() : [];
  const allConstraints = [...baseConstraints, ...detailSentences];
  const noneText = isJa ? "特になし。" : "None.";

  const vars = {
    business_name: job.target.business_name,
    principal_name: principalName,
    principal_ref: principalRef,
    booking_name_line: bookingNameLine,
    objective,
    objective_detail: objectiveDetail,
    opening_ask: openingAsk,
    voicemail_message: voicemailMessage,
    known_facts: knownFacts,
    must_confirm: mustConfirm,
    party_size: String(job.request.party_size ?? ""),
    max_party_size: String(job.request.max_party_size ?? job.request.party_size ?? ""),
    pref_date: job.request.preferred?.date ? prettyDate(job.request.preferred.date) : "",
    pref_time: job.request.preferred?.time ? pretty12h(job.request.preferred.time) : "",
    flex_minutes: String(flex),
    acceptable_windows: windowsStr,
    callback_number: (job.principal && job.principal.callback_number) ?? "",
    special_constraints: allConstraints.length ? allConstraints.join(" ") : noneText,
    preferences: (job.preferences && job.preferences.length) ? job.preferences.join("; ") : noneText,
  };

  // Personal data types available to the agent (shared only if asked).
  const piiKeys = [];
  if (principalName) piiKeys.push("name");
  if (job.principal && job.principal.callback_number) piiKeys.push("callback_number");
  piiKeys.push(...Object.keys(facts).filter((k) => facts[k] != null && facts[k] !== ""));

  return { profile, flex, windows, windowsStr, missingRecommended, detailSentences, vars, piiKeys, isJa };
}

// Resolve agent: language variant (config.agents.by_lang[lang]) -> agents.json
// (call_type | default) -> config.agents.default -> env.
function resolveAgentId(callType, { config = loadConfig(), lang } = {}) {
  const L = String(lang || "en").toLowerCase().split("-")[0];
  if (L && L !== "en" && config.agents?.by_lang?.[L]) return config.agents.by_lang[L];
  const reg = loadJson(AGENTS_PATH, null);
  if (reg) {
    const id = reg[callType] || reg.default || config.agents?.default;
    if (id) return id;
  }
  if (config.agents?.default) return config.agents.default;
  const raw = process.env.RETELL_AGENT_ID || "";
  if (raw.trim().startsWith("{")) {
    const map = JSON.parse(raw);
    if (map[callType]) return map[callType];
  }
  if (raw) return raw;
  throw new Error(`No agent for call_type "${callType}" (no agents.json/config default/env).`);
}

// Build a human-readable read-back (returns lines; does not print).
function buildReadback(job, composed, { testTo, agentId } = {}) {
  const v = composed.vars;
  const lines = [];
  lines.push(`Call type:   ${job.call_type}${composed.profile ? `  (profile: ${composed.profile.name})` : "  (no profile — generic)"}`);
  lines.push(`Calling:     ${job.target.business_name}  ${job.target.phone_number}`);
  if (testTo) lines.push(`  (TEST: actual dial routed to ${testTo})`);
  if (agentId) lines.push(`Agent:       ${agentId}`);
  lines.push(`For:         ${job.request.summary}`);
  // Representative Style-B opening (warm hook -> clear AI disclosure). The exact
  // wording is generated by the agent at call time; this mirrors the prompt so
  // the review gate matches what's actually spoken.
  const openingPreview = composed.isJa
    ? `お世話になっております。${v.opening_ask} このお電話は、ある方に代わってAIアシスタントがおかけしております。`
    : `Hi there! ${v.opening_ask} I'm an AI assistant making this call on someone's behalf.`;
  lines.push(`Opens with:  "${openingPreview}"`);
  if (job.request.party_size) lines.push(`Party:       ${v.party_size} (max ${v.max_party_size})`);
  lines.push(`Preferred:   ${v.pref_date} at ${v.pref_time}  (±${composed.flex} min)`);
  lines.push(`Windows:     ${v.acceptable_windows}`);
  lines.push(`Details:     ${composed.detailSentences.length ? composed.detailSentences.join(" ") : "(none)"}`);
  lines.push(`Constraints: ${v.special_constraints}`);
  lines.push(`Personal data sent (if asked):  ${composed.piiKeys.length ? composed.piiKeys.join(", ") : "(none)"}`);
  lines.push(`Outcome:     pull on demand — ask for the result and it's fetched via get_call_outcome.`);
  if (composed.missingRecommended.length) {
    lines.push("");
    lines.push("⚠️  Profile recommends these details (missing — consider adding):");
    for (const m of composed.missingRecommended) lines.push(`     - ${m.key}: ${m.why}`);
  }
  return lines;
}

// Place the outbound call via Retell. Returns the API response (has call_id).
async function dispatchCall({ key, from, agentId, toNumber, businessNumber, vars }) {
  if (!key) throw new Error("Missing Retell API key.");
  if (!from) throw new Error("Missing from-number.");
  if (!agentId) throw new Error("Missing agent id.");
  const resp = await fetch(`${RETELL_BASE}/v2/create-phone-call`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from_number: from,
      to_number: toNumber || businessNumber,
      override_agent_id: agentId,
      retell_llm_dynamic_variables: vars,
    }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Retell create-phone-call ${resp.status}: ${text}`);
  return JSON.parse(text);
}

// Convenience: full pipeline from a raw job object to a placed (or dry-run) call.
// Returns { ok, errors?, readback, composed, call? }.
async function placeCall(rawJob, { lang = "en", go = false, testTo = null, agentOverride = null, key = process.env.RETELL_API_KEY, from = null } = {}) {
  const config = loadConfig();
  const job = applyConfigBackfill({ ...rawJob }, config);
  const valid = validateJob(job);
  if (!valid.ok) return { ok: false, errors: valid.errors };
  const composed = composeCall(job, { lang });
  // Resolve the agent up-front so the read-back can show it (don't dial yet).
  let agentId = agentOverride;
  if (!agentId) { try { agentId = resolveAgentId(job.call_type, { config, lang }); } catch { agentId = null; } }
  const readback = buildReadback(job, composed, { testTo, agentId });
  if (!go) return { ok: true, dryRun: true, readback, composed, agentId };
  if (!agentId) throw new Error(`No agent resolved for call_type "${job.call_type}" (lang ${lang}). Run setup/configure.`);
  const fromNumber = from || process.env.RETELL_FROM_NUMBER || config.retell?.from_number;
  const call = await dispatchCall({
    key, from: fromNumber, agentId, toNumber: testTo,
    businessNumber: job.target.phone_number, vars: composed.vars,
  });
  return { ok: true, dryRun: false, readback, composed, call };
}

module.exports = {
  SCHEMA_PATH, PROFILES_PATH, CONFIG_PATH, AGENTS_PATH, RETELL_BASE,
  loadConfig, applyConfigBackfill, validateJob, loadProfileFor,
  prettyDate, pretty12h, deriveWindows, composeCall, resolveAgentId,
  buildReadback, dispatchCall, placeCall,
};
