// callwright — shared setup core (NON-interactive, reusable).
//
// Both the CLI wizard (init.js) and the future MCP server build on these.
// Nothing here reads stdin or prints prompts, so it is safe to call from an
// MCP tool handler (stdio-owned) as well as from the terminal wizard.
//
// Responsibilities:
//   - verify a Retell API key (and list agents)
//   - list phone numbers; resolve a from-number
//   - reuse-or-create the generic agent
//   - load/save config.json
//   - report setup status / what's missing (for onboarding prompts)
//   - set principal identity + facts (data the LLM gathered in chat)
//   - guard: tell a caller (LLM) when setup is incomplete before place_call

const fs = require("fs");
const paths = require("./paths");

const BASE = "https://api.retellai.com";
const CONFIG_PATH = paths.CONFIG_PATH;
const AGENTS_PATH = paths.AGENTS_PATH;
const DEFAULT_PROMPT_FILE = "generic-prompt.md";

// Generic post-call analysis (single source of truth; init/setup-agent reuse).
const POST_CALL_ANALYSIS = [
  { type: "enum", name: "status", description: "Final result of the call.",
    choices: ["booked", "failed", "voicemail", "callback_needed", "escalated"] },
  { type: "string", name: "booked_date", description: "Agreed date, or empty." },
  { type: "string", name: "booked_time", description: "Agreed time, or empty." },
  { type: "string", name: "confirmation_ref", description: "Any confirmation name/number." },
  { type: "boolean", name: "accommodations_ok", description: "Were special requests accepted." },
  { type: "string", name: "unmet_items", description: "Anything not achieved, or why it failed." },
  { type: "string", name: "unanswered_questions",
    description: "List any questions the business asked that the agent could NOT answer or had to defer to the principal. Empty if none." },
];

// ---- low-level ----
async function apiCall(key, method, path, body) {
  const opts = { method, headers: { Authorization: `Bearer ${key}` } };
  if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const resp = await fetch(BASE + path, opts);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${method} ${path} -> ${resp.status}\n${text}`);
  return text ? JSON.parse(text) : {};
}

function loadJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return fallback; }
}
function loadConfig() {
  const c = loadJson(CONFIG_PATH, {});
  c.retell = c.retell || {};
  c.agents = c.agents || {};
  c.principal = c.principal || {};
  return c;
}
function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  return config;
}

function loadPromptText(file = DEFAULT_PROMPT_FILE) {
  const raw = fs.readFileSync(file, "utf8");
  const cut = raw.indexOf("# ---");
  return (cut > -1 ? raw.slice(0, cut) : raw).trim();
}

// ---- Retell infra ----
// Verify a key by listing agents. Returns the agents array (throws if invalid).
async function verifyKey(key) {
  if (!key) throw new Error("No RETELL_API_KEY provided.");
  return apiCall(key, "GET", "/list-agents");
}

async function listNumbers(key) {
  // v2 returns unified pagination ({ items, has_more }); unwrap to an array.
  const resp = await apiCall(key, "GET", "/v2/list-phone-numbers");
  return Array.isArray(resp) ? resp : (resp.items || []);
}

// Auto-resolve a from-number: keep the preferred if still present; else if exactly
// one exists use it; else return { needsChoice, numbers } so the caller can ask.
async function resolveFromNumber(key, preferred) {
  const numbers = await listNumbers(key);
  const have = numbers.map((n) => n.phone_number);
  if (preferred && have.includes(preferred)) return { from_number: preferred, numbers };
  if (numbers.length === 1) return { from_number: have[0], numbers };
  if (numbers.length === 0) return { from_number: null, numbers, needsChoice: true, reason: "no_numbers" };
  return { from_number: null, numbers, needsChoice: true, reason: "multiple" };
}

// Reuse an existing generic agent or create one. Returns { agent_id, created }.
async function ensureGenericAgent(key, { agents, defaultId, promptFile = DEFAULT_PROMPT_FILE, voiceId } = {}) {
  agents = agents || (await verifyKey(key));
  const lc = (a) => (a.agent_name || "").toLowerCase();
  // Canonical English default is an agent named exactly "generic".
  const exact = agents.find((a) => lc(a) === "generic");
  // Honor an existing default ONLY if it's still valid AND not being shadowed by
  // a canonical "generic" (self-heals a default mistakenly set to e.g. generic_ja).
  if (defaultId && agents.some((a) => a.agent_id === defaultId)) {
    if (!exact || defaultId === exact.agent_id) {
      return { agent_id: defaultId, created: false, reused: true };
    }
  }
  // Prefer exact English "generic"; avoid language-suffixed variants (generic_ja).
  const byName =
    exact ||
    agents.find((a) => /generic/i.test(lc(a)) && !/_(ja|jp|es|fr|de|zh|ko|pt|it)$/i.test(lc(a))) ||
    agents.find((a) => /generic/i.test(lc(a)));
  if (byName) return { agent_id: byName.agent_id, created: false, reused: true, matchedByName: true };

  const llm = await apiCall(key, "POST", "/create-retell-llm", {
    general_prompt: loadPromptText(promptFile),
    // Phone etiquette: wait for the callee to answer ("Hello?") before the agent
    // introduces itself. begin_after_user_silence_ms is a fallback if they pick
    // up silently (or an IVR doesn't greet) so we don't wait forever.
    start_speaker: "user",
    begin_message: "",
    begin_after_user_silence_ms: 8000,
    general_tools: [
      { type: "end_call", name: "end_call", description: "End the call when done." },
      { type: "press_digit", name: "press_digit",
        description: "Press a keypad digit to navigate an automated phone menu (IVR).",
        delay_ms: 1500 },
    ],
  });
  const agent = await apiCall(key, "POST", "/create-agent", {
    response_engine: { type: "retell-llm", llm_id: llm.llm_id },
    voice_id: voiceId || process.env.RETELL_VOICE_ID || "11labs-Brian",
    agent_name: "generic",
    language: "en-US",
    max_call_duration_ms: 600000,
    interruption_sensitivity: 0.9,
    voicemail_option: { action: { type: "static_text", text: "{{voicemail_message}}" } },
    post_call_analysis_data: POST_CALL_ANALYSIS,
    webhook_events: ["call_started", "call_ended", "call_analyzed"],
  });
  return { agent_id: agent.agent_id, created: true, llm_id: llm.llm_id };
}

// Detect language-variant generic agents by name convention "generic_<lang>"
// (e.g. generic_ja -> { ja: agent_id }). Lets the MCP/CLI route lang -> agent.
function detectLanguageAgents(agents) {
  const out = {};
  for (const a of agents || []) {
    const m = (a.agent_name || "").toLowerCase().match(/^generic[_-]([a-z]{2})$/);
    if (m) out[m[1]] = a.agent_id;
  }
  return out;
}

// Persist resolved infra into config + keep agents.json default in sync.
function applyInfra(config, { from_number, agent_id, by_lang } = {}) {
  if (from_number) config.retell.from_number = from_number;
  if (agent_id) {
    config.agents.default = agent_id;
    const reg = loadJson(AGENTS_PATH, {});
    reg.default = agent_id;
    fs.writeFileSync(AGENTS_PATH, JSON.stringify(reg, null, 2));
  }
  if (by_lang && Object.keys(by_lang).length) {
    config.agents.by_lang = { ...(config.agents.by_lang || {}), ...by_lang };
  }
  return config;
}

// ---- principal grounding ----
// Merge identity + facts the LLM gathered (in chat) or the wizard collected.
function setPrincipal(config, { name, callback_number, facts } = {}) {
  config.principal = config.principal || {};
  if (name != null) config.principal.name = name;
  if (callback_number != null) config.principal.callback_number = callback_number;
  if (facts && typeof facts === "object") {
    config.principal.facts = { ...(config.principal.facts || {}), ...facts };
  }
  return config;
}

// ---- status / guard (drives onboarding prompts) ----
// Report what's configured and what's missing, split by infra vs principal.
function setupStatus(config = loadConfig()) {
  const infraMissing = [];
  if (!config.retell?.from_number) infraMissing.push("retell.from_number");
  if (!(config.agents?.default)) infraMissing.push("agents.default");

  const basicsMissing = [];
  if (!config.principal?.name) basicsMissing.push("name");
  if (!config.principal?.callback_number) basicsMissing.push("callback_number");

  const factKeys = Object.keys(config.principal?.facts || {});
  return {
    infra_ready: infraMissing.length === 0,
    basics_ready: basicsMissing.length === 0,
    ready: infraMissing.length === 0 && basicsMissing.length === 0,
    infra_missing: infraMissing,
    basics_missing: basicsMissing,
    have: {
      from_number: config.retell?.from_number || null,
      default_agent: config.agents?.default || null,
      name: config.principal?.name || null,
      callback_number: config.principal?.callback_number || null,
      fact_keys: factKeys,
    },
  };
}

// Guard for place_call: returns null when OK, or a structured needs_setup object
// instructing the host LLM how to onboard the user (ask basics, call configure).
function guardPlaceCall(config = loadConfig()) {
  const s = setupStatus(config);
  if (s.ready) return null;
  const missing = [...s.infra_missing, ...s.basics_missing];
  const instructions = [];
  if (!s.infra_ready) {
    instructions.push(
      "Infrastructure is not set up. Call run_provisioning (or have the user run `node init.js`) " +
      "to verify the Retell key, select a phone number, and create the generic agent."
    );
  }
  if (!s.basics_ready) {
    instructions.push(
      "Basic principal grounding is missing. Ask the user, in chat, for: " +
      s.basics_missing.join(" and ") +
      " (name is used when a call becomes a booking; callback_number is shared only if a business asks). " +
      "Optionally offer to save a primary/service address. Then call configure with those values."
    );
  }
  return {
    needs_setup: true,
    missing,
    status: s,
    instruction: instructions.join(" "),
  };
}

module.exports = {
  BASE, CONFIG_PATH, AGENTS_PATH, DEFAULT_PROMPT_FILE, POST_CALL_ANALYSIS,
  apiCall, loadConfig, saveConfig, loadPromptText,
  verifyKey, listNumbers, resolveFromNumber, ensureGenericAgent, applyInfra,
  detectLanguageAgents, setPrincipal, setupStatus, guardPlaceCall,
};
