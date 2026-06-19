// Update an existing Retell agent's LLM prompt from a prompt file.
//   node update-prompt.js <agent_id> <prompt-file>
// Env: RETELL_API_KEY
const fs = require("fs");
const API_KEY = process.env.RETELL_API_KEY;
if (!API_KEY) { console.error("Missing RETELL_API_KEY."); process.exit(1); }

const agentId = process.argv[2];
const promptFile = process.argv[3];
if (!agentId || !promptFile) {
  console.error("Usage: node update-prompt.js <agent_id> <prompt-file>");
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
  const agent = await get(`/get-agent/${agentId}`);
  const llmId = agent.response_engine?.llm_id;
  if (!llmId) throw new Error("Agent has no retell-llm engine; cannot update prompt.");
  console.log("agent:", agentId, "-> llm:", llmId);

  // Preserve existing tools; ensure a press_digit tool exists for IVR navigation.
  const llm = await get(`/get-retell-llm/${llmId}`);
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

  await patch(`/update-retell-llm/${llmId}`, {
    general_prompt: loadPrompt(promptFile),
    general_tools: tools,
    // Phone etiquette: wait for the callee to answer before introducing.
    start_speaker: "user",
    begin_message: "",
    begin_after_user_silence_ms: 8000,
  });
  console.log("✅ Prompt + tools + etiquette updated from", promptFile);
  console.log("   tools:", tools.map(t => t.type).join(", "));

  // Ensure the agent leaves a CONTEXTFUL voicemail (who + why + callback),
  // driven by the per-call {{voicemail_message}} dynamic variable.
  const vmText = "{{voicemail_message}}";
  const currentVm = agent.voicemail_option?.action?.text;
  if (currentVm !== vmText) {
    await patch(`/update-agent/${agentId}`, {
      voicemail_option: { action: { type: "static_text", text: vmText } },
    });
    console.log("✅ Voicemail set to contextful {{voicemail_message}}");
  }
})().catch(e => { console.error("\nFailed:\n" + e.message); process.exit(1); });
