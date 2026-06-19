// Create a Retell agent from a prompt file and register it in agents.json.
// Generalizes setup-agent.js so any scenario (or a generic agent) can be made.
//
//   node setup-agent-from.js <prompt-file> <agent_name> [call_type1,call_type2,...]
//
// Example (generic agent that handles appointment_booking + general_inquiry):
//   node setup-agent-from.js generic-prompt.md generic appointment_booking,general_inquiry
//
// Env: RETELL_API_KEY  (no phone number needed)

const fs = require("fs");

const API_KEY = process.env.RETELL_API_KEY;
if (!API_KEY) { console.error("Missing RETELL_API_KEY."); process.exit(1); }

const promptFile = process.argv[2];
const agentName = process.argv[3];
const callTypes = (process.argv[4] || "").split(",").map(s => s.trim()).filter(Boolean);
if (!promptFile || !agentName) {
  console.error("Usage: node setup-agent-from.js <prompt-file> <agent_name> [call_type1,...]");
  process.exit(1);
}

const VOICE_ID = process.env.RETELL_VOICE_ID || "11labs-Adrian";
const AGENT_LANG = process.env.RETELL_AGENT_LANG || "en-US";
const VOICE_MODEL = process.env.RETELL_VOICE_MODEL || null;
const VOICEMAIL_TEXT = process.env.RETELL_VOICEMAIL_TEXT || "{{voicemail_message}}";
const BASE = "https://api.retellai.com";

function loadPrompt(file) {
  const raw = fs.readFileSync(file, "utf8");
  const cut = raw.indexOf("# ---");
  return (cut > -1 ? raw.slice(0, cut) : raw).trim();
}

// Generic post-call analysis (scenario-agnostic).
const postCallAnalysis = [
  { type: "enum", name: "status",
    description: "Final result of the call.",
    choices: ["booked", "failed", "voicemail", "callback_needed", "escalated"] },
  { type: "string", name: "booked_date", description: "Agreed date, or empty." },
  { type: "string", name: "booked_time", description: "Agreed time, or empty." },
  { type: "string", name: "confirmation_ref", description: "Any confirmation name/number." },
  { type: "boolean", name: "accommodations_ok", description: "Were special requests accepted." },
  { type: "string", name: "unmet_items", description: "Anything not achieved, or why it failed." },
  { type: "string", name: "unanswered_questions",
    description: "List any questions the business asked that the agent could NOT answer or had to defer to the principal (e.g. 'what type of haircut', 'preferred stylist'). Empty if none." },
];

async function api(path, body) {
  const resp = await fetch(BASE + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${path} -> ${resp.status}\n${text}`);
  return JSON.parse(text);
}

(async () => {
  console.log(`Creating LLM from ${promptFile}...`);
  const llm = await api("/create-retell-llm", {
    general_prompt: loadPrompt(promptFile),
    general_tools: [
      { type: "end_call", name: "end_call", description: "End the call when done." },
      { type: "press_digit", name: "press_digit",
        description: "Press a keypad digit to navigate an automated phone menu (IVR). Use whenever a menu instructs you to press a number to reach a department or person.",
        delay_ms: 1500 },
    ],
  });
  console.log("  llm_id:", llm.llm_id);

  console.log("Creating agent...");
  const agentBody = {
    response_engine: { type: "retell-llm", llm_id: llm.llm_id },
    voice_id: VOICE_ID,
    agent_name: agentName,
    language: AGENT_LANG,
    max_call_duration_ms: 300000,
    interruption_sensitivity: 0.9,
    voicemail_option: { action: { type: "static_text", text: VOICEMAIL_TEXT } },
    post_call_analysis_data: postCallAnalysis,
    webhook_events: ["call_started", "call_ended", "call_analyzed"],
  };
  if (VOICE_MODEL) agentBody.voice_model = VOICE_MODEL;
  const agent = await api("/create-agent", agentBody);
  console.log("  agent_id:", agent.agent_id);

  // Register in agents.json for the given call types.
  const reg = fs.existsSync("agents.json") ? JSON.parse(fs.readFileSync("agents.json", "utf8")) : {};
  for (const ct of callTypes) reg[ct] = agent.agent_id;
  fs.writeFileSync("agents.json", JSON.stringify(reg, null, 2));
  console.log("\nRegistered in agents.json for:", callTypes.join(", ") || "(none)");
  console.log(JSON.stringify(reg, null, 2));
})().catch(e => { console.error("\nFailed:\n" + e.message); process.exit(1); });
