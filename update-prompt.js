// Update an existing Retell agent's LLM prompt from a prompt file.
//   node update-prompt.js <agent_id> <prompt-file> --agent-version <version|tag> [--dry-run] [--prompt-analysis-only]
// Env: RETELL_API_KEY
const fs = require("fs");
const { isDeepStrictEqual } = require("util");
const setup = require("./setup-core");
const API_KEY = process.env.RETELL_API_KEY;
if (!API_KEY) { console.error("Missing RETELL_API_KEY."); process.exit(1); }

const agentId = process.argv[2];
const promptFile = process.argv[3];
const dryRun = process.argv.includes("--dry-run");
const promptAnalysisOnly = process.argv.includes("--prompt-analysis-only");
const agentVersionIdx = process.argv.indexOf("--agent-version");
const agentVersionRaw = agentVersionIdx > -1 ? process.argv[agentVersionIdx + 1] : null;
const agentVersion = agentVersionRaw != null && /^\d+$/.test(agentVersionRaw)
  ? Number(agentVersionRaw)
  : agentVersionRaw;
if (!agentId || !promptFile) {
  console.error("Usage: node update-prompt.js <agent_id> <prompt-file> --agent-version <version|tag> [--dry-run] [--prompt-analysis-only]");
  process.exit(1);
}
const BASE = "https://api.retellai.com";

function loadPrompt(file) {
  const raw = fs.readFileSync(file, "utf8");
  const cut = raw.indexOf("# ---");
  return (cut > -1 ? raw.slice(0, cut) : raw).trim();
}

async function get(path) {
  const resp = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${path} -> ${resp.status}\n${text}`);
  return JSON.parse(text);
}

async function patch(path, body) {
  const resp = await fetch(BASE + path, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${path} -> ${resp.status}\n${text}`);
  return JSON.parse(text);
}

(async () => {
  if (agentVersion == null) {
    throw new Error("--agent-version is required so Retell reads, updates, and verification target one version.");
  }
  if (promptAnalysisOnly) {
    const result = await setup.syncPromptAndAnalysis(
      API_KEY,
      agentId,
      loadPrompt(promptFile),
      { dryRun, agentVersion }
    );
    console.log("target:", JSON.stringify(result.target, null, 2));
    console.log("changes:", JSON.stringify(result.changes, null, 2));
    console.log("prompt:", JSON.stringify(result.prompt, null, 2));
    console.log("analysis:", JSON.stringify(result.analysis, null, 2));
    if (result.warnings.length) console.log("warnings:", result.warnings.join(", "));
    console.log(dryRun ? "Dry run only; no Retell settings changed." : "Prompt and analysis update verified.");
    return;
  }

  const initialAgent = await get(`/get-agent/${agentId}?version=${encodeURIComponent(String(agentVersion))}`);
  const resolvedAgentVersion = initialAgent.version;
  if (!Number.isInteger(resolvedAgentVersion)) {
    throw new Error("Retell agent response did not include a numeric version.");
  }
  const agent = initialAgent;
  const llmId = agent.response_engine?.llm_id;
  if (!llmId) throw new Error("Agent has no retell-llm engine; cannot update prompt.");
  const llmVersion = agent.response_engine?.version;
  if (!Number.isInteger(llmVersion)) {
    throw new Error("Agent response engine did not include a numeric LLM version.");
  }
  console.log(`agent: ${agentId} version ${resolvedAgentVersion} -> llm: ${llmId} version ${llmVersion}`);

  const llm = await get(`/get-retell-llm/${llmId}?version=${llmVersion}`);
  if (llm.version !== llmVersion) {
    throw new Error(`LLM version mismatch: agent uses ${llmVersion}, Retell returned ${llm.version}.`);
  }
  const tools = Array.isArray(llm.general_tools) ? llm.general_tools.slice() : [];
  if (!tools.some(t => t.type === "press_digit")) {
    tools.push({
      type: "press_digit",
      name: "press_digit",
      description: "Press a keypad digit to navigate an automated phone menu (IVR). Use whenever a menu instructs you to press a number to reach a department or person.",
      delay_ms: 1500,
    });
    console.log("  + added press_digit tool");
  }
  if (!tools.some(t => t.type === "end_call")) {
    tools.push({ type: "end_call", name: "end_call", description: "End the call when done." });
  }

  const llmPatch = {};
  const desiredPrompt = loadPrompt(promptFile);
  if (llm.general_prompt !== desiredPrompt) llmPatch.general_prompt = desiredPrompt;
  if (JSON.stringify(llm.general_tools || []) !== JSON.stringify(tools)) llmPatch.general_tools = tools;
  if (llm.start_speaker !== "user") llmPatch.start_speaker = "user";
  if ((llm.begin_message || "") !== "") llmPatch.begin_message = "";
  if (llm.begin_after_user_silence_ms !== 8000) llmPatch.begin_after_user_silence_ms = 8000;

  const agentPatch = setup.buildPostCallAnalysisPatch(agent) || {};
  const vmText = "{{voicemail_message}}";
  const currentVm = agent.voicemail_option?.action?.text;
  if (currentVm !== vmText) {
    agentPatch.voicemail_option = { action: { type: "static_text", text: vmText } };
  }

  const base = (process.env.CALLWRIGHT_PUBLIC_URL || "").replace(/\/+$/, "");
  if (base) {
    const url = `${base}/webhook/retell`;
    const requiredEvents = ["call_started", "call_ended", "call_analyzed"];
    if (agent.webhook_url !== url) agentPatch.webhook_url = url;
    const currentEvents = Array.isArray(agent.webhook_events)
      ? agent.webhook_events.slice().sort()
      : [];
    if (JSON.stringify(currentEvents) !== JSON.stringify(requiredEvents.slice().sort())) {
      agentPatch.webhook_events = ["call_started", "call_ended", "call_analyzed"];
    }
  }

  const llmChanges = Object.keys(llmPatch);
  const agentChanges = Object.keys(agentPatch);
  console.log("LLM changes:", llmChanges.length ? llmChanges.join(", ") : "(none)");
  console.log("Agent changes:", agentChanges.length ? agentChanges.join(", ") : "(none)");

  if (dryRun) {
    console.log("Dry run only; no Retell settings changed.");
    return;
  }

  if (llmChanges.length) await patch(`/update-retell-llm/${llmId}?version=${llmVersion}`, llmPatch);
  if (agentChanges.length) await patch(`/update-agent/${agentId}?version=${resolvedAgentVersion}`, agentPatch);

  const updatedAgent = await get(`/get-agent/${agentId}?version=${resolvedAgentVersion}`);
  const updatedLlm = await get(`/get-retell-llm/${llmId}?version=${llmVersion}`);
  for (const [key, expected] of Object.entries(llmPatch)) {
    if (!isDeepStrictEqual(updatedLlm[key], expected)) {
      throw new Error(`LLM verification failed for ${key}.`);
    }
  }
  for (const [key, expected] of Object.entries(agentPatch)) {
    if (!isDeepStrictEqual(updatedAgent[key], expected)) {
      throw new Error(`Agent verification failed for ${key}.`);
    }
  }
  console.log("Updated and verified prompt configuration from", promptFile);
})().catch(e => { console.error("\nFailed:\n" + e.message); process.exit(1); });
