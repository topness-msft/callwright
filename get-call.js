// Fetch a call's outcome + transcript by polling Retell's API.
// dispatch.js prints a call_id; pass it here to poll until the post-call
// analysis is ready. (Retell is the system of record.)
//
// Setup:  $env:RETELL_API_KEY = "key_..."
// Run:    node get-call.js <call_id>

const API_KEY = process.env.RETELL_API_KEY;
const outcome = require("./outcome-core");
if (!API_KEY) {
  console.error("Missing RETELL_API_KEY env var.");
  process.exit(1);
}

const callId = process.argv[2];
if (!callId) {
  console.error("Usage: node get-call.js <call_id>");
  process.exit(1);
}

const BASE = "https://api.retellai.com";

async function getCall() {
  const resp = await fetch(`${BASE}/v2/get-call/${callId}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`get-call -> ${resp.status}\n${text}`);
  return JSON.parse(text);
}

function printOutcome(call) {
  const a = call.call_analysis || {};
  const line = "=".repeat(60);
  console.log(`\n${line}`);
  console.log("call_id:        ", call.call_id);
  console.log("dashboard:      ", `https://dashboard.retellai.com/call-history?history=${call.call_id}`);
  console.log("call_status:    ", call.call_status);
  console.log("disconnect:     ", call.disconnection_reason);
  console.log("duration (s):   ", call.duration_ms ? Math.round(call.duration_ms / 1000) : "n/a");
  console.log("outcome:        ", JSON.stringify(outcome.resolveOutcome(call), null, 2));
  console.log("--- post-call analysis ---");
  console.log("custom fields:  ", JSON.stringify(a.custom_analysis_data ?? {}, null, 2));
  console.log("successful:     ", a.call_successful);
  console.log("summary:        ", a.call_summary);
  console.log(line);
}

(async () => {
  const maxTries = 60; // ~5 min at 5s
  for (let i = 0; i < maxTries; i++) {
    const call = await getCall();
    const done = call.call_status === "ended" || call.call_status === "error";
    const analyzed = !!call.call_analysis;

    if (done && analyzed) {
      printOutcome(call);
      return;
    }
    if (done && !analyzed) {
      // call finished; analysis lags a few seconds
      process.stdout.write(".");
    } else {
      process.stdout.write(`[${call.call_status}]`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log("\nTimed out waiting for analysis. Try: node get-call.js " + callId);
})().catch((e) => {
  console.error("\nFailed:\n" + e.message);
  process.exit(1);
});
