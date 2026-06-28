// callwright — language management core (add/update/remove a call language at
// runtime). Pure-ish: Retell API calls are injectable (deps.api) for testing;
// file/config IO uses the real volume (paths). composeCall stays language-
// agnostic — adding a language is DATA: a translated prompt + phrase block +
// a Retell agent registered in config.agents.by_lang.
//
// English is the built-in base (managed in the repo); add_language is for
// ADDITIONAL languages only.

const fs = require("fs");
const paths = require("./paths");
const setup = require("./setup-core");

const PHRASES_FILE = "lang-phrases.json";
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const MAX_PROMPT = 50000;

// Common BCP-47 primary subtag -> Retell agent language code.
const RETELL_LANG_MAP = {
  en: "en-US", ja: "ja-JP", fr: "fr-FR", es: "es-ES", de: "de-DE", zh: "zh-CN",
  ko: "ko-KR", pt: "pt-PT", it: "it-IT", nl: "nl-NL", hi: "hi-IN", ru: "ru-RU",
  pl: "pl-PL", tr: "tr-TR", ar: "ar-SA", id: "id-ID", vi: "vi-VN", th: "th-TH",
};

// Primary subtag -> the `accent` label Retell uses, for voice suggestions.
const ACCENT_HINT = {
  en: "American", ja: "Japanese", fr: "French", es: "Spanish", de: "German",
  zh: "Chinese", ko: "Korean", pt: "Portuguese", it: "Italian", nl: "Dutch",
  hi: "Indian", ru: "Russian", ar: "Arabic", tr: "Turkish",
};

// Placeholder groups each phrase template MUST preserve (>=1 per group).
const PLACEHOLDER_REQS = {
  opening_ask_fallback: [["objective", "objective_lc"]],
  voicemail_callback: [["objective", "objective_lc"], ["callback"]],
  voicemail_no_callback: [["objective", "objective_lc"]],
  booking_name_line_named: [["name"]],
  opening_preview: [["opening_ask"]],
};

const REQUIRED_PROMPT_VARS = ["objective", "opening_ask", "voicemail_message", "acceptable_windows"];

// ---- pure helpers ----
function normalizeLang(lang) {
  const l = String(lang || "").toLowerCase().trim();
  const valid = LANG_RE.test(l);
  return { lang: l, primary: l.split("-")[0], valid };
}

function toRetellLanguage(primary, override) {
  if (override) return { language: override, guessed: false };
  if (RETELL_LANG_MAP[primary]) return { language: RETELL_LANG_MAP[primary], guessed: false };
  return { language: `${primary}-${primary.toUpperCase()}`, guessed: true };
}

function validatePromptText(text) {
  const errors = [];
  const s = String(text || "");
  if (!s.trim()) errors.push("prompt_text is empty.");
  if (s.length > MAX_PROMPT) errors.push(`prompt_text too long (${s.length} > ${MAX_PROMPT}).`);
  for (const v of REQUIRED_PROMPT_VARS) {
    if (!s.includes(`{{${v}}}`)) errors.push(`prompt_text must keep the {{${v}}} variable.`);
  }
  return { ok: errors.length === 0, errors };
}

function validatePhrases(phrases, seed) {
  const errors = [];
  if (!phrases || typeof phrases !== "object") return { ok: false, errors: ["phrases must be an object."] };
  for (const key of Object.keys(seed)) {
    if (!(key in phrases)) { errors.push(`Missing phrase key: ${key}`); continue; }
    const sv = seed[key];
    const pv = phrases[key];
    if (key === "confirm") {
      if (!pv || typeof pv !== "object" || !Array.isArray(pv.base) || pv.base.length === 0
          || typeof pv.join !== "string" || !(pv.party_size === null || typeof pv.party_size === "string")) {
        errors.push("confirm must be { base: [strings], party_size: string|null, join: string }.");
      }
    } else if (typeof sv === "string") {
      if (typeof pv !== "string") errors.push(`${key} must be a string.`);
    }
    const reqs = PLACEHOLDER_REQS[key];
    if (reqs && typeof pv === "string") {
      for (const group of reqs) {
        if (!group.some((ph) => pv.includes(`{${ph}}`))) {
          errors.push(`${key} must keep the placeholder ${group.map((g) => `{${g}}`).join(" or ")}.`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function suggestVoices(voices, primary, limit = 6) {
  const want = (ACCENT_HINT[primary] || "").toLowerCase();
  const list = (voices || []).filter((v) => want && String(v.accent || "").toLowerCase().includes(want));
  return list.slice(0, limit).map((v) => ({
    voice_id: v.voice_id, voice_name: v.voice_name, provider: v.provider, accent: v.accent, gender: v.gender,
  }));
}

function resolveVoiceId(voices, voice_id, primary) {
  if (voice_id) {
    const found = (voices || []).some((v) => v.voice_id === voice_id);
    if (!found) {
      return { error: `Voice "${voice_id}" is not in the Retell catalog. Use list_voices to pick a real voice_id.`, suggestions: suggestVoices(voices, primary) };
    }
    return { voice_id };
  }
  return { voice_id: "11labs-Brian", default: true, suggestions: suggestVoices(voices, primary) };
}

// ---- io helpers ----
function atomicWrite(file, content) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  try { fs.renameSync(tmp, file); }
  catch { fs.writeFileSync(file, content); try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } }
}
function readVolumePhrases() {
  try { return JSON.parse(fs.readFileSync(paths.volumePath(PHRASES_FILE), "utf8")); } catch { return {}; }
}
function writePhraseBlock(primary, block) {
  const cur = readVolumePhrases();
  cur[primary] = block;
  atomicWrite(paths.volumePath(PHRASES_FILE), JSON.stringify(cur, null, 2));
}
function removePhraseBlock(primary) {
  const cur = readVolumePhrases();
  delete cur[primary];
  atomicWrite(paths.volumePath(PHRASES_FILE), JSON.stringify(cur, null, 2));
}
function enSeed() {
  try { return JSON.parse(fs.readFileSync(PHRASES_FILE, "utf8")).en || {}; } catch { return {}; }
}
const defaultApi = (key) => (m, p, b) => setup.apiCall(key, m, p, b);

// Serialize add/update/remove so concurrent volume writes can't interleave.
let _chain = Promise.resolve();
function withLock(fn) {
  const run = _chain.then(fn, fn);
  _chain = run.then(() => {}, () => {});
  return run;
}

// ---- voices ----
async function listVoices(key, { accent, query, limit = 40 } = {}, deps = {}) {
  const api = deps.api || defaultApi(key);
  let voices = [];
  try { voices = await api("GET", "/list-voices"); } catch (e) { return { error: `Could not list voices: ${e.message}` }; }
  let list = voices || [];
  if (accent) list = list.filter((v) => String(v.accent || "").toLowerCase().includes(String(accent).toLowerCase()));
  if (query) {
    const q = String(query).toLowerCase();
    list = list.filter((v) => `${v.voice_name} ${v.provider} ${v.accent}`.toLowerCase().includes(q));
  }
  return {
    total: (voices || []).length,
    showing: Math.min(list.length, limit),
    voices: list.slice(0, limit).map((v) => ({
      voice_id: v.voice_id, voice_name: v.voice_name, provider: v.provider,
      accent: v.accent, gender: v.gender, age: v.age, preview_audio_url: v.preview_audio_url,
    })),
  };
}

// ---- add ----
async function addLanguage(key, args, deps = {}) {
  const api = deps.api || defaultApi(key);
  return withLock(() => _addLanguage(api, args || {}));
}

async function _addLanguage(api, { lang, display_name, prompt_text, phrases, voice_id, language, stt_mode, interruption_sensitivity }) {
  const { lang: L, primary, valid } = normalizeLang(lang);
  if (!valid) return { error: `Invalid language code "${lang}". Use a BCP-47 code like "fr" or "pt-BR".` };
  if (primary === "en") return { error: "English is the built-in base language (managed in the repo, generic-prompt.md). add_language is for ADDITIONAL languages." };

  const config = setup.loadConfig();
  if (config.agents?.by_lang?.[primary] || config.languages?.[primary]) {
    const a = config.agents?.by_lang?.[primary];
    return { error: `Language "${primary}" is already registered${a ? ` (agent ${a})` : ""}. Use update_language to change it, or remove_language first.` };
  }

  const seed = enSeed();
  if (!prompt_text || !phrases) {
    return {
      needs_translation: true,
      lang: primary,
      display_name: display_name || primary,
      base_prompt: setup.loadPromptText("generic-prompt.md"),
      base_phrases: seed,
      instructions: `Translate base_prompt and base_phrases into ${display_name || primary} (${primary}). Preserve every {{variable}} and {placeholder} EXACTLY — do not translate the tokens inside the braces. Then call add_language again with prompt_text and phrases (and ideally a native-accent voice_id from list_voices).`,
    };
  }

  const pv = validatePromptText(prompt_text);
  if (!pv.ok) return { error: "Invalid prompt_text.", details: pv.errors };
  const phv = validatePhrases(phrases, seed);
  if (!phv.ok) return { error: "Invalid phrases.", details: phv.errors };

  let voices = [];
  try { voices = await api("GET", "/list-voices"); } catch { voices = []; }
  const vr = resolveVoiceId(voices, voice_id, primary);
  if (vr.error) return { error: vr.error, suggestions: vr.suggestions };
  const resolvedVoice = vr.voice_id;

  const { language: retellLang, guessed } = toRetellLanguage(primary, language);
  const stt = stt_mode || "accurate";
  const interrupt = (typeof interruption_sensitivity === "number") ? interruption_sensitivity : 0.5;
  if (interrupt < 0 || interrupt > 1) return { error: "interruption_sensitivity must be between 0 and 1." };

  const promptFileName = `generic-prompt.${primary}.md`;
  try {
    atomicWrite(paths.volumePath(promptFileName), String(prompt_text));
    writePhraseBlock(primary, phrases);
  } catch (e) {
    return { error: `Failed to write language assets to the volume: ${e.message}` };
  }

  // Reuse an existing generic_<primary> agent (idempotent re-run) instead of
  // creating a duplicate.
  let agents = [];
  try { agents = await api("GET", "/list-agents"); } catch { agents = []; }
  const existing = (agents || []).find((a) => (a.agent_name || "").toLowerCase() === `generic_${primary}`);

  let agent_id, llm_id;
  if (existing) {
    agent_id = existing.agent_id;
    llm_id = existing.response_engine?.llm_id || null;
    if (llm_id) { try { await api("PATCH", `/update-retell-llm/${llm_id}`, { general_prompt: setup.loadPromptText(promptFileName) }); } catch { /* best effort */ } }
    try { await api("PATCH", `/update-agent/${agent_id}`, { voice_id: resolvedVoice, language: retellLang }); } catch { /* best effort */ }
  } else {
    let llm;
    try {
      llm = await api("POST", "/create-retell-llm", {
        general_prompt: setup.loadPromptText(promptFileName),
        start_speaker: "user",
        begin_message: "",
        begin_after_user_silence_ms: 8000,
        general_tools: [
          { type: "end_call", name: "end_call", description: "End the call when done." },
          { type: "press_digit", name: "press_digit", description: "Press a keypad digit to navigate an automated phone menu (IVR).", delay_ms: 1500 },
        ],
      });
    } catch (e) {
      return { error: `Failed to create the Retell LLM: ${e.message}`, note: "Volume files were written; re-run add_language with the same inputs to retry." };
    }
    llm_id = llm.llm_id;
    let agent;
    try {
      agent = await api("POST", "/create-agent", {
        response_engine: { type: "retell-llm", llm_id },
        voice_id: resolvedVoice,
        agent_name: `generic_${primary}`,
        language: retellLang,
        max_call_duration_ms: 600000,
        interruption_sensitivity: interrupt,
        stt_mode: stt,
        voicemail_option: { action: { type: "static_text", text: "{{voicemail_message}}" } },
        post_call_analysis_data: setup.POST_CALL_ANALYSIS,
        webhook_events: ["call_started", "call_ended", "call_analyzed"],
        ...(setup.webhookUrl() ? { webhook_url: setup.webhookUrl() } : {}),
      });
    } catch (e) {
      try { await api("DELETE", `/delete-retell-llm/${llm_id}`); } catch { /* ignore */ }
      return { error: `Failed to create the Retell agent: ${e.message}`, note: "Volume files were written and the orphan LLM was cleaned up; re-run add_language with the same inputs to retry." };
    }
    agent_id = agent.agent_id;
  }

  // Register (config saved LAST so a mid-flight failure leaves it unregistered/safe).
  config.agents = config.agents || {};
  config.agents.by_lang = { ...(config.agents.by_lang || {}), [primary]: agent_id };
  config.languages = { ...(config.languages || {}), [primary]: { agent_id, llm_id, voice_id: resolvedVoice, language: retellLang, display_name: display_name || primary } };
  setup.saveConfig(config);

  return {
    ok: true,
    lang: primary,
    display_name: display_name || primary,
    agent_id,
    llm_id,
    voice_id: resolvedVoice,
    language: retellLang,
    language_guessed: guessed || undefined,
    voice_note: vr.default ? `Defaulted to ${resolvedVoice} (the English house voice). For a natural-sounding ${display_name || primary} call, consider a native-accent voice (list_voices) and update_language.` : undefined,
    voice_suggestions: vr.default ? vr.suggestions : undefined,
    next: `Run a VERIFICATION CALL to your own number before any production use: place_call with lang:"${primary}", test_to:"<your number>", confirm:true. Have a native speaker review the opening, the AI disclosure, and etiquette. Then it's ready.`,
  };
}

// ---- update ----
async function updateLanguage(key, args, deps = {}) {
  const api = deps.api || defaultApi(key);
  return withLock(() => _updateLanguage(api, args || {}));
}

async function _updateLanguage(api, { lang, prompt_text, phrases, voice_id, language, interruption_sensitivity, stt_mode }) {
  const { primary, valid } = normalizeLang(lang);
  if (!valid) return { error: "Invalid language code." };
  if (primary === "en") return { error: "English base is managed in the repo, not via update_language." };

  const config = setup.loadConfig();
  const meta = config.languages?.[primary];
  const agent_id = config.agents?.by_lang?.[primary] || meta?.agent_id;
  if (!agent_id) return { error: `Language "${primary}" is not registered. Use add_language first.` };

  let llm_id = meta?.llm_id;
  if (!llm_id) { try { const a = await api("GET", `/get-agent/${agent_id}`); llm_id = a.response_engine?.llm_id; } catch { /* ignore */ } }

  const seed = enSeed();
  const changed = {};
  const promptFileName = `generic-prompt.${primary}.md`;

  if (prompt_text) {
    const pv = validatePromptText(prompt_text);
    if (!pv.ok) return { error: "Invalid prompt_text.", details: pv.errors };
    atomicWrite(paths.volumePath(promptFileName), String(prompt_text));
    if (llm_id) { await api("PATCH", `/update-retell-llm/${llm_id}`, { general_prompt: setup.loadPromptText(promptFileName) }); }
    changed.prompt = true;
  }
  if (phrases) {
    const phv = validatePhrases(phrases, seed);
    if (!phv.ok) return { error: "Invalid phrases.", details: phv.errors };
    writePhraseBlock(primary, phrases);
    changed.phrases = true;
  }

  const agentPatch = {};
  if (voice_id) {
    let voices = [];
    try { voices = await api("GET", "/list-voices"); } catch { voices = []; }
    const vr = resolveVoiceId(voices, voice_id, primary);
    if (vr.error) return { error: vr.error, suggestions: vr.suggestions };
    agentPatch.voice_id = vr.voice_id;
  }
  if (language) agentPatch.language = language;
  if (typeof interruption_sensitivity === "number") {
    if (interruption_sensitivity < 0 || interruption_sensitivity > 1) return { error: "interruption_sensitivity must be between 0 and 1." };
    agentPatch.interruption_sensitivity = interruption_sensitivity;
  }
  if (stt_mode) agentPatch.stt_mode = stt_mode;
  if (Object.keys(agentPatch).length) { await api("PATCH", `/update-agent/${agent_id}`, agentPatch); changed.agent = Object.keys(agentPatch); }

  config.languages = config.languages || {};
  config.languages[primary] = {
    ...(meta || { agent_id, llm_id }),
    ...(agentPatch.voice_id ? { voice_id: agentPatch.voice_id } : {}),
    ...(agentPatch.language ? { language: agentPatch.language } : {}),
  };
  setup.saveConfig(config);
  return { ok: true, lang: primary, changed };
}

// ---- remove ----
async function removeLanguage(key, args, deps = {}) {
  const api = deps.api || defaultApi(key);
  return withLock(() => _removeLanguage(api, args || {}));
}

async function _removeLanguage(api, { lang, delete_agent }) {
  const { primary, valid } = normalizeLang(lang);
  if (!valid) return { error: "Invalid language code." };
  if (primary === "en") return { error: "Cannot remove the built-in English base language." };

  const config = setup.loadConfig();
  const meta = config.languages?.[primary];
  const agent_id = config.agents?.by_lang?.[primary] || meta?.agent_id;
  if (!agent_id && !meta) return { error: `Language "${primary}" is not registered.` };

  let agent_deleted = false;
  if (delete_agent && agent_id) {
    let llm_id = meta?.llm_id;
    if (!llm_id) { try { const a = await api("GET", `/get-agent/${agent_id}`); llm_id = a.response_engine?.llm_id; } catch { /* ignore */ } }
    try { await api("DELETE", `/delete-agent/${agent_id}`); agent_deleted = true; } catch { /* leave note */ }
    if (llm_id) { try { await api("DELETE", `/delete-retell-llm/${llm_id}`); } catch { /* ignore */ } }
  }

  if (config.agents?.by_lang) delete config.agents.by_lang[primary];
  if (config.languages) delete config.languages[primary];
  setup.saveConfig(config);

  try { fs.rmSync(paths.volumePath(`generic-prompt.${primary}.md`), { force: true }); } catch { /* ignore */ }
  try { removePhraseBlock(primary); } catch { /* ignore */ }

  return {
    ok: true,
    lang: primary,
    agent_deleted,
    note: delete_agent
      ? undefined
      : `Unregistered "${primary}" and removed its volume assets. The Retell agent ${agent_id || ""} still exists in your Retell dashboard (pass delete_agent:true to delete it too).`,
  };
}

// ---- verification ----
// Build a representative anonymous general-inquiry job to verify a language's
// composed phrasing. Pass target-language samples for the truest review; if
// omitted, composeCall falls back to the language's own opening_ask_fallback.
function buildVerificationJob(primary, { business_name, sample_summary, sample_opening_ask } = {}) {
  const d = new Date(Date.now() + 7 * 86400000);
  const date = d.toISOString().slice(0, 10);
  const request = {
    summary: sample_summary || "availability inquiry (verification call)",
    preferred: { date, time: "18:00" },
  };
  if (sample_opening_ask) request.opening_ask = sample_opening_ask;
  return {
    call_type: "general_inquiry",
    target: { business_name: business_name || "Verification call", phone_number: "+10000000000" },
    principal: { anonymous: true },
    request,
  };
}

// Extract a human/native review card from a composed verification call: the
// exact spoken opening (greeting wrapper + ask + AI disclosure) and voicemail,
// which are the phrase-block-derived strings a native speaker must sign off on.
function verificationCard(composed, { lang, display_name, agent_id, voice_id, language } = {}) {
  const v = composed.vars || {};
  const tpl = (composed.phrases && composed.phrases.opening_preview) || "{opening_ask}";
  const opening = String(tpl).replace(/\{(\w+)\}/g, (_, k) => (v[k] != null ? String(v[k]) : ""));
  return {
    lang,
    display_name: display_name || lang,
    agent_id: agent_id || null,
    voice_id: voice_id || null,
    language: language || null,
    opening_spoken: opening,
    voicemail_spoken: v.voicemail_message || "",
    name_handling: v.booking_name_line || "",
    review_checklist: [
      "Is the AI disclosure present, clear, and natural (not buried, never claims to be human)?",
      "Is the greeting/etiquette appropriate for the culture (e.g. keigo in Japanese, tu/vous in French)?",
      "Does the voicemail message sound natural and leave who/why/callback clearly?",
      "Any awkward or literal machine-translation phrasing to fix via update_language?",
      "Does the voice accent/gender suit the language? (change via update_language voice_id)",
    ],
  };
}

// ---- status ----
function listLanguages(config = setup.loadConfig()) {
  const out = [{ lang: "en", display_name: "English", base: true, agent_id: config.agents?.default || null }];
  const langs = config.languages || {};
  const byLang = config.agents?.by_lang || {};
  const volPhr = readVolumePhrases();
  for (const k of new Set([...Object.keys(langs), ...Object.keys(byLang)])) {
    const m = langs[k] || {};
    out.push({
      lang: k,
      display_name: m.display_name || k,
      agent_id: byLang[k] || m.agent_id || null,
      voice_id: m.voice_id || null,
      language: m.language || null,
      prompt_on_volume: fs.existsSync(paths.volumePath(`generic-prompt.${k}.md`)),
      phrases_on_volume: !!volPhr[k],
    });
  }
  return out;
}

module.exports = {
  normalizeLang, toRetellLanguage, validatePromptText, validatePhrases,
  suggestVoices, resolveVoiceId, listVoices,
  addLanguage, updateLanguage, removeLanguage, listLanguages,
  buildVerificationJob, verificationCard,
  RETELL_LANG_MAP, ACCENT_HINT,
};
