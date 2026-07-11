// callwright — CLI dispatcher (thin wrapper over dispatch-core.js).
//
//   node dispatch.js <job.json>                         # dry-run: validate + read-back
//   node dispatch.js <job.json> --go                    # actually place the call
//   node dispatch.js <job.json> --to +1...              # route the dial to a test number
//   node dispatch.js <job.json> --lang ja               # Japanese composed strings
//   node dispatch.js <job.json> --agent agent_xxx       # force a specific agent
//   node dispatch.js <job.json> --agent-version 3       # pin an exact Retell agent version
//
// Env: RETELL_API_KEY (required for --go). from-number + agent resolve from
// config.json / agents.json (see `node init.js`).

const fs = require("fs");
const core = require("./dispatch-core");

const jobFile = process.argv[2];
const GO = process.argv.includes("--go");
const toIdx = process.argv.indexOf("--to");
const TEST_TO = toIdx > -1 ? process.argv[toIdx + 1] : null;
const langIdx = process.argv.indexOf("--lang");
const LANG = (langIdx > -1 ? process.argv[langIdx + 1] : (process.env.CALL_LANG || "en")).toLowerCase();
const agentIdx = process.argv.indexOf("--agent");
const AGENT_OVERRIDE = agentIdx > -1 ? process.argv[agentIdx + 1] : null;
const agentVersionIdx = process.argv.indexOf("--agent-version");
const agentVersionRaw = agentVersionIdx > -1 ? process.argv[agentVersionIdx + 1] : null;
if (agentVersionIdx > -1 && (!agentVersionRaw || agentVersionRaw.startsWith("--"))) {
  console.error("--agent-version requires a numeric version or tag.");
  process.exit(1);
}
const AGENT_VERSION = agentVersionRaw != null && /^\d+$/.test(agentVersionRaw)
  ? Number(agentVersionRaw)
  : agentVersionRaw;

if (!jobFile) {
  console.error("Usage: node dispatch.js <job.json> [--go] [--to +1...] [--lang ja] [--agent agent_xxx] [--agent-version 3]");
  process.exit(1);
}

const rawJob = JSON.parse(fs.readFileSync(jobFile, "utf8"));

(async () => {
  const result = await core.placeCall(rawJob, {
    lang: LANG, go: GO, testTo: TEST_TO, agentOverride: AGENT_OVERRIDE, agentVersion: AGENT_VERSION,
  });

  if (!result.ok) {
    console.error("❌ Job does NOT conform to place_call.schema.json:\n");
    for (const e of result.errors) console.error(`  ${e}`);
    process.exit(1);
  }

  console.log("✅ Job conforms to place_call.schema.json");
  console.log("\n--- READ-BACK (confirm before dialing) ---");
  console.log(result.readback.join("\n"));

  if (result.dryRun) {
    console.log("\n[dry run] Not dialing. Re-run with --go to place the call.");
    return;
  }

  console.log("\n📞 Call dispatched.");
  console.log("call_id:", result.call.call_id);
  console.log("dashboard:", `https://dashboard.retellai.com/call-history?history=${result.call.call_id}`);
  console.log("Read outcome with:  node get-call.js " + result.call.call_id);
})().catch((e) => { console.error("\n" + (e.message || e)); process.exit(1); });
