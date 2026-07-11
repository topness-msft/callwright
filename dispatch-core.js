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
const retry = require("./retry-core");

const SCHEMA_PATH = "place_call.schema.json";
const PROFILES_PATH = paths.PROFILES_PATH;
const CONFIG_PATH = paths.CONFIG_PATH;
const AGENTS_PATH = paths.AGENTS_PATH;
const RETELL_BASE = "https://api.retellai.com";

function loadJson(p, fb) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; }
}
function loadConfig() { return loadJson(CONFIG_PATH, {}); }

// Per-language PHRASING. Code injects values; this data owns wording. Keyed by
// BCP-47 primary subtag; unknown languages fall back to English so a call never
// crashes for lack of a phrase block (it just speaks English helper text).
// Volume-first: the image ships en/ja seeds; a volume copy (runtime-added
// languages) is merged on top per language block. Not cached — the file is tiny
// and add_language may write to it at runtime.
const PHRASES_FILE = "lang-phrases.json";
function loadPhrases() {
  const image = loadJson(PHRASES_FILE, { en: {} });
  if (paths.DATA_DIR !== ".") {
    const vol = loadJson(paths.volumePath(PHRASES_FILE), null);
    if (vol) return { ...image, ...vol };
  }
  return image;
}
function phrasesFor(lang) {
  const all = loadPhrases();
  const L = String(lang || "en").toLowerCase();
  return all[L] || all[L.split("-")[0]] || all.en || {};
}
// Minimal {key} interpolation; missing keys render as "".
function interp(tpl, vars = {}) {
  return String(tpl || "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
}

function validateOpeningAsk(input) {
  const value = String(input ?? "").trim();
  const errors = [];
  if (!value) errors.push("opening_empty");
  if (/[\r\n]/.test(value)) errors.push("opening_multiline");
  if (/^(?:[-*]|\u2022|\d+[.)])\s/.test(value)) errors.push("opening_list_format");
  if (Array.from(value).length > 180) errors.push("opening_too_long");
  if ((value.match(/[?\uFF1F\u061F]/g) || []).length > 1) errors.push("opening_multiple_questions");
  if (/\b(?:and\s+(?:also\s+)?(?:hop(?:e|ing)|want(?:ing)?|need(?:ing)?|plan(?:ning)?)(?:\s+to)?|and\s+(?:also\s+)?(?:schedule|book|reserve|arrange|confirm|check|ask|find|send|provide|connect|tell)|and (?:if|whether)|if so|then)\b/i.test(value)) {
    errors.push("opening_multiple_steps");
  }
  if (/\b(?:connect|transfer)\b[^?]{0,120}\b(?:to\s+(?:confirm|ask|check|find)|whether|if)\b/i.test(value)
      || /\b(?:connect|transfer)\b[^.!?]{0,120}[.!?]\s*\S/i.test(value)
      || /(?:\u7e4b|\u3064\u306a|\u8ee2\u9001|\u62c5\u5f53\u8005).{0,80}\u3002\s*\S/.test(value)) {
    errors.push("opening_routing_bundle");
  }
  if (/(?:\u3068|\u304a\u3088\u3073|\u306a\u3089\u3073\u306b)[\u3001,]|(?:\u307e\u305f|\u305d\u306e\u5f8c)[\u3001,]|\u3082\u3057.+\u306a\u3089|\u3068(?:\u4e88\u7d04|\u5229\u7528|\u7a7a\u304d|\u6599\u91d1|\u4fa1\u683c|\u5bfe\u5fdc|\u53ef\u5426)/.test(value)) {
    errors.push("opening_multiple_steps");
  }
  return { ok: errors.length === 0, value, errors };
}

function invalidOpeningError(errors) {
  const error = new Error(`Invalid opening_ask: ${errors.join(", ")}`);
  error.code = "INVALID_OPENING_ASK";
  error.validationErrors = errors;
  return error;
}

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
// `lang` selects the per-language PHRASE block (lang-phrases.json) used for
// composed helper strings. composeCall has no language conditionals — phrasing
// is data; this function only injects values.
function composeCall(job, { lang = "en", config = loadConfig() } = {}) {
  const LANG = String(lang || "en").toLowerCase();
  const P = phrasesFor(LANG);
  const profile = loadProfileFor(job.call_type);

  const flex = job.overrides?.time_flexibility_minutes ?? profile?.default_flex_minutes ?? 45;
  const windows = deriveWindows(job.request, flex);
  const windowsStr = windows
    .map((w, i) => `${i + 1}) ${prettyDate(w.date)}, ${pretty12h(w.earliest)}-${pretty12h(w.latest)}`)
    .join("   ");

  const details = job.scenario_details || {};
  // Resolve stored facts into the per-call "share-if-asked" set. The store
  // (config.principal.facts) holds durable PII; a call attaches ONLY the subset
  // this scenario needs — data minimization — so the raw values never pass
  // through the calling model. Two eligibility sources:
  //   - the matched profile's recommended_details keys (auto-resolved), and
  //   - keys the caller explicitly names in principal.facts_from_store (opt-in
  //     escape hatch for a non-recommended stored key).
  // An explicit principal.facts value always wins over the store (no override,
  // no double-attach); empty stored values are treated as absent.
  const jobFacts = (job.principal && job.principal.facts) || {};
  const storedFacts = (config && config.principal && config.principal.facts) || {};
  const requestedFromStore = Array.isArray(job.principal && job.principal.facts_from_store)
    ? job.principal.facts_from_store
    : [];
  const resolveKeys = new Set([
    ...(profile?.recommended_details ? Object.keys(profile.recommended_details) : []),
    ...requestedFromStore,
  ]);
  const resolvedFromStore = {};
  for (const key of resolveKeys) {
    if (jobFacts[key] != null && jobFacts[key] !== "") continue; // caller value wins
    const v = storedFacts[key];
    if (v != null && v !== "") resolvedFromStore[key] = v;
  }
  const facts = { ...resolvedFromStore, ...jobFacts };
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
  const onBehalf = hasName ? interp(P.behalf_named, { name: principalName }) : "";
  const principalRef = hasName ? principalName : P.principal_ref_anon;

  const objective = job.request.summary;
  // Trimmed/lowercased forms shared by the phrase templates (opening, voicemail).
  const objectiveTrim = String(objective || "").trim().replace(/[.?!。、]+$/, "");
  const objectiveLc = objectiveTrim.charAt(0).toLowerCase() + objectiveTrim.slice(1);
  const serviceType = details.service_type ? ` (${details.service_type})` : "";
  const objectiveDetail = job.request.party_size
    ? `${job.request.summary}${serviceType} (party of ${job.request.party_size}).`
    : `${job.request.summary}${serviceType}.`;

  // The spoken purpose line. PREFER an explicit, call-language opening_ask that the
  // host LLM authored (it writes fluent, natural sentences). Only fall back to a
  // simple, language-neutral derivation when opening_ask is absent.
  const rawOpeningAsk = job.request.opening_ask
    || interp(P.opening_ask_fallback, { objective: objectiveTrim, objective_lc: objectiveLc });
  const openingValidation = validateOpeningAsk(rawOpeningAsk);
  if (!openingValidation.ok) throw invalidOpeningError(openingValidation.errors);
  const openingAsk = openingValidation.value;

  const callbackNumber = (job.principal && job.principal.callback_number) || "";
  const voicemailMessage = interp(
    callbackNumber ? P.voicemail_callback : P.voicemail_no_callback,
    { behalf: onBehalf, objective: objectiveTrim, objective_lc: objectiveLc, callback: callbackNumber }
  );

  const composeKnownFacts = (f) => {
    const entries = Object.entries(f || {}).filter(([, v]) => v != null && v !== "");
    if (!entries.length) return P.known_facts_none;
    return entries
      .map(([k, v]) => `- ${k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}: ${v}`)
      .join("\n");
  };
  const knownFacts = composeKnownFacts(facts);

  const bookingNameLine = hasName
    ? interp(P.booking_name_line_named, { name: principalName })
    : P.booking_name_line_anon;

  // Default confirm list is built from per-language labels; party size is added
  // only when present AND the language opts in (cf.party_size non-null).
  const defaultConfirm = (() => {
    const cf = P.confirm || { base: ["the date", "the time"], party_size: "the party size", join: ", " };
    const parts = (cf.base || []).slice();
    if (job.request.party_size && cf.party_size) parts.splice(2, 0, cf.party_size);
    return parts.join(cf.join != null ? cf.join : ", ");
  })();
  const mustConfirm = (job.must_confirm && job.must_confirm.length)
    ? job.must_confirm.join(", ")
    : (profile?.must_confirm ? profile.must_confirm.join(", ") : defaultConfirm);

  const baseConstraints = (job.constraints && job.constraints.length) ? job.constraints.slice() : [];
  const allConstraints = [...baseConstraints, ...detailSentences];
  const noneText = P.none_text;

  // Retry policy (default: exactly 1 retry on no-answer/busy/failed). Round-tripped
  // in the dynamic vars so the webhook can decide from the call_ended payload and
  // the incrementing attempt counter makes the chain self-terminating.
  const retryPolicy = retry.parseRetryPolicy(job.overrides && job.overrides.retry);
  const retryVars = retry.policyToVars(retryPolicy, 0);

  // Per-call SMS notify intent (opt-in). Round-tripped so the call_analyzed
  // webhook can text the user. Default off (results pulled via get_call_outcome).
  const notifySms = !!(job.notify && job.notify.sms);
  const notifyVars = { notify_sms: notifySms ? "1" : "0", notify_to: (job.notify && job.notify.to) || "" };
  const ticktickTaskId = String(job.tracking?.ticktick_task_id || "").trim();
  const metadata = ticktickTaskId
    ? { source: "ticktick", ticktick_task_id: ticktickTaskId, schema_version: 1 }
    : undefined;

  const vars = {
    business_name: job.target.business_name,
    // Round-tripped metadata (not spoken; echoed back in the call_analyzed
    // webhook payload so auto-learn knows the scenario + language).
    call_type: job.call_type || "",
    call_lang: LANG,
    // Retry policy round-trip (read back from the call_ended webhook payload).
    ...retryVars,
    // SMS notify intent round-trip (read back from the call_analyzed webhook).
    ...notifyVars,
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

  return { profile, flex, windows, windowsStr, missingRecommended, detailSentences, vars, metadata, piiKeys, lang: LANG, phrases: P, retryPolicy };
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
function buildReadback(job, composed, { testTo, agentId, agentVersion } = {}) {
  const v = composed.vars;
  const lines = [];
  lines.push(`Call type:   ${job.call_type}${composed.profile ? `  (profile: ${composed.profile.name})` : "  (no profile — generic)"}`);
  lines.push(`Calling:     ${job.target.business_name}  ${job.target.phone_number}`);
  if (testTo) lines.push(`  (TEST: actual dial routed to ${testTo})`);
  if (agentId) lines.push(`Agent:       ${agentId}${agentVersion != null ? `  (version ${agentVersion})` : ""}`);
  lines.push(`For:         ${job.request.summary}`);
  // Representative Style-B opening (warm hook -> clear AI disclosure). The exact
  // wording is generated by the agent at call time; this mirrors the prompt so
  // the review gate matches what's actually spoken. Phrasing is per-language data.
  const openingPreview = interp(
    (composed.phrases && composed.phrases.opening_preview) || "{opening_ask}",
    { opening_ask: v.opening_ask }
  );
  lines.push(`Opens with:  "${openingPreview}"`);
  if (job.request.party_size) lines.push(`Party:       ${v.party_size} (max ${v.max_party_size})`);
  lines.push(`Preferred:   ${v.pref_date} at ${v.pref_time}  (±${composed.flex} min)`);
  lines.push(`Windows:     ${v.acceptable_windows}`);
  lines.push(`Details:     ${composed.detailSentences.length ? composed.detailSentences.join(" ") : "(none)"}`);
  lines.push(`Constraints: ${v.special_constraints}`);
  lines.push(`Personal data sent (if asked):  ${composed.piiKeys.length ? composed.piiKeys.join(", ") : "(none)"}`);
  lines.push(`Outcome:     pull on demand — ask for the result and it's fetched via get_call_outcome.`);
  lines.push(`Retry:       ${retry.describePolicy(composed.retryPolicy)}`);
  if (v.notify_sms === "1") lines.push(`Notify:      SMS to ${v.notify_to || "(your saved number)"} when done`);
  if (composed.missingRecommended.length) {
    lines.push("");
    lines.push("⚠️  Profile recommends these details (missing — consider adding):");
    for (const m of composed.missingRecommended) lines.push(`     - ${m.key}: ${m.why}`);
  }
  return lines;
}

// Place the outbound call via Retell. Returns the API response (has call_id).
async function dispatchCall({ key, from, agentId, agentVersion, toNumber, businessNumber, vars, metadata }) {
  if (!key) throw new Error("Missing Retell API key.");
  if (!from) throw new Error("Missing from-number.");
  if (!agentId) throw new Error("Missing agent id.");
  const openingValidation = validateOpeningAsk(vars && vars.opening_ask);
  if (!openingValidation.ok) throw invalidOpeningError(openingValidation.errors);
  const resp = await fetch(`${RETELL_BASE}/v2/create-phone-call`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from_number: from,
      to_number: toNumber || businessNumber,
      override_agent_id: agentId,
      ...(agentVersion != null ? { override_agent_version: agentVersion } : {}),
      retell_llm_dynamic_variables: vars,
      ...(metadata ? { metadata } : {}),
    }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Retell create-phone-call ${resp.status}: ${text}`);
  return JSON.parse(text);
}

// Re-dial a finished call for a retry. Reuses the original call's from/to/agent
// and dynamic vars, bumping retry_attempt so the chain self-terminates. Returns
// the new Retell call object.
async function redialFromCall(call, { key = process.env.RETELL_API_KEY, attempt } = {}) {
  const vars = retry.buildRetryVars(call.retell_llm_dynamic_variables || {}, attempt);
  return dispatchCall({
    key,
    from: call.from_number,
    agentId: call.agent_id || call.override_agent_id,
    agentVersion: call.agent_version,
    toNumber: call.to_number,
    businessNumber: call.to_number,
    vars,
    metadata: call.metadata || undefined,
  });
}

// Convenience: full pipeline from a raw job object to a placed (or dry-run) call.
// Returns { ok, errors?, readback, composed, call? }.
async function placeCall(rawJob, { lang = "en", go = false, testTo = null, agentOverride = null, agentVersion = null, key = process.env.RETELL_API_KEY, from = null } = {}) {
  const config = loadConfig();
  const job = applyConfigBackfill({ ...rawJob }, config);
  const valid = validateJob(job);
  if (!valid.ok) return { ok: false, errors: valid.errors };
  let composed;
  try {
    composed = composeCall(job, { lang, config });
  } catch (error) {
    if (error && error.code === "INVALID_OPENING_ASK") {
      return { ok: false, errors: error.validationErrors };
    }
    throw error;
  }
  // Resolve the agent up-front so the read-back can show it (don't dial yet).
  let agentId = agentOverride;
  if (!agentId) { try { agentId = resolveAgentId(job.call_type, { config, lang }); } catch { agentId = null; } }
  const readback = buildReadback(job, composed, { testTo, agentId, agentVersion });
  if (!go) return { ok: true, dryRun: true, readback, composed, agentId };
  if (!agentId) throw new Error(`No agent resolved for call_type "${job.call_type}" (lang ${lang}). Run setup/configure.`);
  const fromNumber = from || process.env.RETELL_FROM_NUMBER || config.retell?.from_number;
  const call = await dispatchCall({
    key, from: fromNumber, agentId, agentVersion, toNumber: testTo,
    businessNumber: job.target.phone_number, vars: composed.vars, metadata: composed.metadata,
  });
  return { ok: true, dryRun: false, readback, composed, call };
}

module.exports = {
  SCHEMA_PATH, PROFILES_PATH, CONFIG_PATH, AGENTS_PATH, RETELL_BASE,
  loadConfig, applyConfigBackfill, validateJob, loadProfileFor,
  prettyDate, pretty12h, deriveWindows, validateOpeningAsk, composeCall, resolveAgentId,
  buildReadback, dispatchCall, redialFromCall, placeCall,
};
