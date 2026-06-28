// TDD suite for lang-core (add_language + companions).
// Uses a temp volume dir set BEFORE requiring modules so paths.DATA_DIR points at it.
const os = require("os");
const fs = require("fs");
const path = require("path");

const VOL = fs.mkdtempSync(path.join(os.tmpdir(), "cw-lang-"));
process.env.CALLWRIGHT_DATA_DIR = VOL;

const test = require("node:test");
const assert = require("node:assert");

// Require AFTER env is set.
const lc = require("../lang-core.js");
const dc = require("../dispatch-core.js");
const setup = require("../setup-core.js");
const paths = require("../paths.js");

// ---- fixtures ----
const EN_PHRASES = JSON.parse(fs.readFileSync("lang-phrases.json", "utf8")).en;
const JA_PHRASES = JSON.parse(fs.readFileSync("lang-phrases.json", "utf8")).ja;
const BASE_PROMPT = setup.loadPromptText("generic-prompt.md");

// A valid French phrase block (placeholders preserved).
const FR_PHRASES = {
  principal_ref_anon: "la personne que j'assiste",
  behalf_named: " pour le compte de {name}",
  opening_ask_fallback: "J'appelle au sujet de {objective_lc}. Pourriez-vous m'aider ?",
  voicemail_callback: "Bonjour, ceci est un assistant IA{behalf}. J'appelle pour {objective_lc}. Rappelez le {callback}. Merci.",
  voicemail_no_callback: "Bonjour, ceci est un assistant IA{behalf}. J'appelle pour {objective_lc}. Merci.",
  known_facts_none: "Aucune information.",
  booking_name_line_named: "Si une reservation est faite, utilisez **{name}**.",
  booking_name_line_anon: "Simple demande de renseignements - aucun nom.",
  confirm: { base: ["la date", "l'heure"], party_size: "le nombre de personnes", join: ", " },
  none_text: "Aucune.",
  opening_preview: "Bonjour ! {opening_ask} Je suis un assistant IA appelant pour le compte de quelqu'un.",
};
const FR_PROMPT = "# PROMPT FR\nConduisez l'appel en francais. Objectif : {{objective}}. {{opening_ask}} {{acceptable_windows}} Repondeur : {{voicemail_message}}";

const VOICES = [
  { voice_id: "11labs-Brian", voice_name: "Brian", provider: "elevenlabs", accent: "American", gender: "male" },
  { voice_id: "minimax-Yumi", voice_name: "Yumi", provider: "minimax", accent: "Japanese", gender: "female" },
  { voice_id: "elevenlabs-Margot", voice_name: "Margot", provider: "elevenlabs", accent: "French", gender: "female" },
];

// Build a fake Retell api(method, path, body) that records calls.
function makeApi(opts = {}) {
  const calls = [];
  const existingAgents = opts.agents || [];
  const api = async (method, p, body) => {
    calls.push({ method, path: p, body });
    if (method === "GET" && p === "/list-voices") return VOICES;
    if (method === "GET" && p === "/list-agents") return existingAgents;
    if (method === "POST" && p === "/create-retell-llm") {
      if (opts.failCreateLlm) throw new Error("llm boom");
      return { llm_id: "llm_new" };
    }
    if (method === "POST" && p === "/create-agent") {
      if (opts.failCreateAgent) throw new Error("agent boom");
      return { agent_id: "agent_new" };
    }
    if (p.startsWith("/get-agent/")) return { agent_id: p.split("/").pop(), response_engine: { llm_id: "llm_existing" }, voice_id: "minimax-Yumi", language: "fr-FR" };
    if (p.startsWith("/update-retell-llm/")) return { ok: true };
    if (p.startsWith("/update-agent/")) return { ok: true };
    if (p.startsWith("/delete-agent/")) return {};
    if (p.startsWith("/delete-retell-llm/")) return {};
    return {};
  };
  return { api, calls };
}

function resetVol() {
  for (const f of fs.readdirSync(VOL)) fs.rmSync(path.join(VOL, f), { recursive: true, force: true });
}
test.beforeEach(resetVol);
test.after(() => fs.rmSync(VOL, { recursive: true, force: true }));

// ---- pure helpers ----
test("normalizeLang", () => {
  assert.deepEqual(lc.normalizeLang("FR"), { lang: "fr", primary: "fr", valid: true });
  assert.equal(lc.normalizeLang("zh-CN").primary, "zh");
  assert.equal(lc.normalizeLang("pt-BR").primary, "pt");
  assert.equal(lc.normalizeLang("english").valid, false);
  assert.equal(lc.normalizeLang("").valid, false);
});

test("toRetellLanguage", () => {
  assert.equal(lc.toRetellLanguage("ja").language, "ja-JP");
  assert.equal(lc.toRetellLanguage("fr").language, "fr-FR");
  assert.equal(lc.toRetellLanguage("fr", "fr-CA").language, "fr-CA"); // override wins
  const guess = lc.toRetellLanguage("xx");
  assert.equal(guess.language, "xx-XX");
  assert.equal(guess.guessed, true);
});

test("validatePhrases: en and ja seeds are valid", () => {
  assert.equal(lc.validatePhrases(EN_PHRASES, EN_PHRASES).ok, true);
  assert.equal(lc.validatePhrases(JA_PHRASES, EN_PHRASES).ok, true);
  assert.equal(lc.validatePhrases(FR_PHRASES, EN_PHRASES).ok, true);
});

test("validatePhrases: missing key fails", () => {
  const bad = { ...FR_PHRASES }; delete bad.opening_preview;
  const r = lc.validatePhrases(bad, EN_PHRASES);
  assert.equal(r.ok, false);
  assert.ok(r.errors.join(" ").includes("opening_preview"));
});

test("validatePhrases: dropped placeholder fails", () => {
  const bad = { ...FR_PHRASES, booking_name_line_named: "Utilisez le nom fourni." }; // dropped {name}
  const r = lc.validatePhrases(bad, EN_PHRASES);
  assert.equal(r.ok, false);
  assert.ok(r.errors.join(" ").includes("{name}"));
});

test("validatePhrases: bad confirm shape fails", () => {
  const bad = { ...FR_PHRASES, confirm: "date, time" };
  assert.equal(lc.validatePhrases(bad, EN_PHRASES).ok, false);
});

test("validatePromptText", () => {
  assert.equal(lc.validatePromptText(FR_PROMPT).ok, true);
  assert.equal(lc.validatePromptText("no variables here").ok, false);
  assert.equal(lc.validatePromptText("x".repeat(60000)).ok, false);
});

test("resolveVoiceId: existing ok, missing errors, none -> default + suggestions", () => {
  assert.equal(lc.resolveVoiceId(VOICES, "minimax-Yumi").voice_id, "minimax-Yumi");
  assert.ok(lc.resolveVoiceId(VOICES, "not-real").error);
  const def = lc.resolveVoiceId(VOICES, null, "fr");
  assert.equal(def.voice_id, "11labs-Brian");
  assert.ok(def.suggestions.some((v) => v.accent === "French"));
});

// ---- addLanguage ----
test("addLanguage: handshake when prompt_text/phrases omitted (no side effects)", async () => {
  const { api, calls } = makeApi();
  const r = await lc.addLanguage("k", { lang: "fr", display_name: "French" }, { api });
  assert.equal(r.needs_translation, true);
  assert.ok(r.base_prompt.length > 0);
  assert.ok(r.base_phrases.opening_preview);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(VOL, "generic-prompt.fr.md")), false);
});

test("addLanguage: rejects english", async () => {
  const { api } = makeApi();
  const r = await lc.addLanguage("k", { lang: "en", display_name: "English", prompt_text: FR_PROMPT, phrases: FR_PHRASES }, { api });
  assert.ok(r.error && /english/i.test(JSON.stringify(r)));
});

test("addLanguage: rejects already-registered", async () => {
  setup.saveConfig({ retell: {}, agents: { by_lang: { fr: "agent_x" } }, principal: {}, languages: { fr: { agent_id: "agent_x" } } });
  const { api } = makeApi();
  const r = await lc.addLanguage("k", { lang: "fr", display_name: "French", prompt_text: FR_PROMPT, phrases: FR_PHRASES }, { api });
  assert.ok(r.error && /registered/i.test(JSON.stringify(r)));
});

test("addLanguage: rejects invalid phrases", async () => {
  const bad = { ...FR_PHRASES }; delete bad.voicemail_callback;
  const { api } = makeApi();
  const r = await lc.addLanguage("k", { lang: "fr", display_name: "French", prompt_text: FR_PROMPT, phrases: bad }, { api });
  assert.ok(r.error && /voicemail_callback/.test(JSON.stringify(r)));
});

test("addLanguage: happy path writes files, creates llm+agent, registers, composes native", async () => {
  const { api, calls } = makeApi();
  const r = await lc.addLanguage("k", { lang: "fr", display_name: "French", prompt_text: FR_PROMPT, phrases: FR_PHRASES, voice_id: "elevenlabs-Margot" }, { api });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.agent_id, "agent_new");
  assert.equal(r.language, "fr-FR");
  // files
  assert.ok(fs.existsSync(path.join(VOL, "generic-prompt.fr.md")));
  const volPhr = JSON.parse(fs.readFileSync(path.join(VOL, "lang-phrases.json"), "utf8"));
  assert.ok(volPhr.fr.opening_preview);
  // api: created agent with right name/voice/language
  const created = calls.find((c) => c.path === "/create-agent");
  assert.equal(created.body.agent_name, "generic_fr");
  assert.equal(created.body.voice_id, "elevenlabs-Margot");
  assert.equal(created.body.language, "fr-FR");
  // config registration
  const cfg = setup.loadConfig();
  assert.equal(cfg.agents.by_lang.fr, "agent_new");
  assert.equal(cfg.languages.fr.llm_id, "llm_new");
  // composeCall now native
  const job = { call_type: "general_inquiry", target: { business_name: "Cafe", phone_number: "+33100000000" }, principal: { anonymous: true }, request: { summary: "ask about walk-ins", preferred: { date: "2026-07-01", time: "20:00" } } };
  const composed = dc.composeCall(job, { lang: "fr" });
  assert.ok(composed.vars.voicemail_message.startsWith("Bonjour"));
  assert.equal(composed.vars.special_constraints, "Aucune.");
});

test("addLanguage: reuses an existing generic_fr Retell agent", async () => {
  const { api, calls } = makeApi({ agents: [{ agent_id: "agent_pre", agent_name: "generic_fr", response_engine: { llm_id: "llm_pre" } }] });
  const r = await lc.addLanguage("k", { lang: "fr", display_name: "French", prompt_text: FR_PROMPT, phrases: FR_PHRASES, voice_id: "elevenlabs-Margot" }, { api });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.agent_id, "agent_pre");
  assert.equal(calls.some((c) => c.path === "/create-agent"), false); // did not create a duplicate
  assert.equal(setup.loadConfig().agents.by_lang.fr, "agent_pre");
});

test("addLanguage: agent-create failure -> not registered, llm cleaned up, files remain", async () => {
  const { api, calls } = makeApi({ failCreateAgent: true });
  const r = await lc.addLanguage("k", { lang: "fr", display_name: "French", prompt_text: FR_PROMPT, phrases: FR_PHRASES, voice_id: "elevenlabs-Margot" }, { api });
  assert.ok(r.error);
  assert.equal(setup.loadConfig().agents?.by_lang?.fr, undefined);
  assert.ok(calls.some((c) => c.path.startsWith("/delete-retell-llm/"))); // orphan llm cleaned
  assert.ok(fs.existsSync(path.join(VOL, "generic-prompt.fr.md"))); // files remain for re-run
});

test("addLanguage: preserves existing volume phrase blocks", async () => {
  fs.writeFileSync(path.join(VOL, "lang-phrases.json"), JSON.stringify({ es: { none_text: "Ninguno." } }));
  const { api } = makeApi();
  await lc.addLanguage("k", { lang: "fr", display_name: "French", prompt_text: FR_PROMPT, phrases: FR_PHRASES, voice_id: "elevenlabs-Margot" }, { api });
  const volPhr = JSON.parse(fs.readFileSync(path.join(VOL, "lang-phrases.json"), "utf8"));
  assert.ok(volPhr.es, "existing es block preserved");
  assert.ok(volPhr.fr, "new fr block added");
});

test("removeLanguage: unregisters, deletes files, composeCall falls back to en", async () => {
  const { api } = makeApi();
  await lc.addLanguage("k", { lang: "fr", display_name: "French", prompt_text: FR_PROMPT, phrases: FR_PHRASES, voice_id: "elevenlabs-Margot" }, { api });
  const r = await lc.removeLanguage("k", { lang: "fr" }, { api });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(setup.loadConfig().agents?.by_lang?.fr, undefined);
  assert.equal(fs.existsSync(path.join(VOL, "generic-prompt.fr.md")), false);
  const volPhr = JSON.parse(fs.readFileSync(path.join(VOL, "lang-phrases.json"), "utf8"));
  assert.equal(volPhr.fr, undefined);
  // falls back to English phrasing
  const job = { call_type: "general_inquiry", target: { business_name: "Cafe", phone_number: "+33100000000" }, principal: { anonymous: true }, request: { summary: "ask", preferred: { date: "2026-07-01", time: "20:00" } } };
  assert.equal(dc.composeCall(job, { lang: "fr" }).vars.special_constraints, "None.");
});

test("removeLanguage: delete_agent calls Retell delete", async () => {
  const { api, calls } = makeApi();
  await lc.addLanguage("k", { lang: "fr", display_name: "French", prompt_text: FR_PROMPT, phrases: FR_PHRASES, voice_id: "elevenlabs-Margot" }, { api });
  await lc.removeLanguage("k", { lang: "fr", delete_agent: true }, { api });
  assert.ok(calls.some((c) => c.path.startsWith("/delete-agent/")));
});

test("updateLanguage: voice change PATCHes the agent", async () => {
  const { api, calls } = makeApi();
  await lc.addLanguage("k", { lang: "fr", display_name: "French", prompt_text: FR_PROMPT, phrases: FR_PHRASES, voice_id: "elevenlabs-Margot" }, { api });
  const r = await lc.updateLanguage("k", { lang: "fr", voice_id: "minimax-Yumi" }, { api });
  assert.equal(r.ok, true, JSON.stringify(r));
  const patched = calls.filter((c) => c.path.startsWith("/update-agent/")).pop();
  assert.equal(patched.body.voice_id, "minimax-Yumi");
  assert.equal(setup.loadConfig().languages.fr.voice_id, "minimax-Yumi");
});

test("listLanguages: shows registered + en base", async () => {
  const { api } = makeApi();
  await lc.addLanguage("k", { lang: "fr", display_name: "French", prompt_text: FR_PROMPT, phrases: FR_PHRASES, voice_id: "elevenlabs-Margot" }, { api });
  const list = lc.listLanguages(setup.loadConfig());
  const fr = list.find((l) => l.lang === "fr");
  assert.equal(fr.agent_id, "agent_new");
  assert.ok(fr.prompt_on_volume);
});

// ---- verification helpers ----
test("buildVerificationJob: target-language samples flow into the job", () => {
  const job = lc.buildVerificationJob("fr", { sample_summary: "verifier la disponibilite", sample_opening_ask: "Avez-vous de la place ce soir ?" });
  assert.equal(job.call_type, "general_inquiry");
  assert.equal(job.principal.anonymous, true);
  assert.equal(job.request.opening_ask, "Avez-vous de la place ce soir ?");
  assert.equal(job.request.summary, "verifier la disponibilite");
  assert.ok(job.request.preferred.date && job.request.preferred.time);
});

test("buildVerificationJob: defaults when samples omitted", () => {
  const job = lc.buildVerificationJob("fr", {});
  assert.ok(job.request.summary);
  assert.equal(job.request.opening_ask, undefined); // lets composeCall use the language fallback
});

test("verificationCard: surfaces phrase-composed opening + voicemail for review", async () => {
  const { api } = makeApi();
  await lc.addLanguage("k", { lang: "fr", display_name: "French", prompt_text: FR_PROMPT, phrases: FR_PHRASES, voice_id: "elevenlabs-Margot" }, { api });
  const job = lc.buildVerificationJob("fr", { sample_summary: "verifier la disponibilite", sample_opening_ask: "Avez-vous de la place ce soir ?" });
  const composed = dc.composeCall(job, { lang: "fr" });
  const card = lc.verificationCard(composed, { lang: "fr", display_name: "French", agent_id: "agent_new", voice_id: "elevenlabs-Margot", language: "fr-FR" });
  assert.ok(card.opening_spoken.startsWith("Bonjour !"));
  assert.ok(card.opening_spoken.includes("Avez-vous de la place"));
  assert.ok(card.voicemail_spoken.startsWith("Bonjour, ceci est un assistant IA"));
  assert.equal(card.voice_id, "elevenlabs-Margot");
  assert.ok(Array.isArray(card.review_checklist) && card.review_checklist.length > 0);
});
