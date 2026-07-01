#!/usr/bin/env node
// callwright — first-run setup wizard (terminal on-ramp).
//
//   node init.js            # interactive (or scripted via piped stdin)
//   node init.js status     # print what's configured / missing
//
// Thin CLI over setup-core.js — the SAME functions the MCP server's
// configure / get_setup_status / run_provisioning tools call. Keeps a single
// source of truth for setup logic across the local and hosted paths.

const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const core = require("./setup-core");

// Support both interactive (TTY) and scripted (piped stdin) use.
const INTERACTIVE = Boolean(stdin.isTTY);
let rl = null;
let queuedLines = [];
function readAllStdin() {
  return new Promise((resolve) => {
    let buf = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (d) => (buf += d));
    stdin.on("end", () => resolve(buf));
    stdin.on("error", () => resolve(buf));
  });
}

async function ask(q, def) {
  const suffix = def ? ` [${def}]` : "";
  let ans;
  if (INTERACTIVE) {
    ans = (await rl.question(`${q}${suffix}: `)).trim();
  } else {
    ans = (queuedLines.length ? queuedLines.shift() : "").trim();
    console.log(`${q}${suffix}: ${ans}`);
  }
  return ans || def || "";
}
async function askYesNo(q, defYes) {
  const ans = (await ask(`${q} (${defYes ? "Y/n" : "y/N"})`)).toLowerCase();
  if (!ans) return defYes;
  return ans.startsWith("y");
}

// `node init.js status` — non-interactive status report.
function printStatus() {
  const s = core.setupStatus();
  console.log("\n=== callwright setup status ===");
  console.log("Ready:", s.ready ? "yes" : "no");
  console.log("  from_number:   ", s.have.from_number || "(missing)");
  console.log("  default_agent: ", s.have.default_agent || "(missing)");
  console.log("  name:          ", s.have.name || "(missing)");
  console.log("  callback:      ", s.have.callback_number || "(missing)");
  console.log("  fact keys:     ", s.have.fact_keys.length ? s.have.fact_keys.join(", ") : "(none)");
  if (!s.ready) console.log("Missing:", [...s.infra_missing, ...s.basics_missing].join(", "));
  console.log("");
}

async function wizard() {
  console.log("\n=== callwright setup ===\n");
  if (INTERACTIVE) {
    rl = readline.createInterface({ input: stdin, output: stdout });
  } else {
    queuedLines = (await readAllStdin()).split(/\r?\n/);
  }
  const config = core.loadConfig();

  // --- 1. API key ---
  let key = process.env.RETELL_API_KEY;
  if (key) {
    console.log("Using RETELL_API_KEY from environment.");
  } else {
    key = await ask("Retell API key (key_...)");
    if (!key) { console.error("An API key is required: https://dashboard.retellai.com/apiKey"); process.exit(1); }
  }

  let agents;
  try {
    agents = await core.verifyKey(key);
    console.log(`Key verified - ${agents.length} agent(s) in this workspace.`);
  } catch (e) {
    console.error("Could not verify API key:\n" + e.message);
    process.exit(1);
  }

  // --- 2. Phone number ---
  const res = await core.resolveFromNumber(key, config.retell.from_number);
  let fromNumber = res.from_number;
  if (!fromNumber && res.reason === "no_numbers") {
    console.log("\nNo phone numbers in this Retell workspace.");
    console.log("  Buy one in the dashboard (Phone Numbers -> Buy), then re-run init.");
    fromNumber = await ask("Or paste a number to use now (E.164, +1...)", config.retell.from_number);
  } else if (!fromNumber && res.reason === "multiple") {
    console.log("\nYour Retell numbers:");
    res.numbers.forEach((n, i) => console.log(`  ${i + 1}) ${n.phone_number}${n.nickname ? "  (" + n.nickname + ")" : ""}`));
    const pick = await ask("Pick a number to call FROM", "1");
    fromNumber = res.numbers[(parseInt(pick, 10) || 1) - 1].phone_number;
  } else {
    console.log(`\nFrom number: ${fromNumber}`);
  }

  // --- 3. Generic agent (reuse or create) ---
  let agentRes = await core.ensureGenericAgent(key, { agents, defaultId: config.agents.default });
  if (agentRes.reused) {
    console.log(`Reusing generic agent: ${agentRes.agent_id}${agentRes.matchedByName ? " (matched by name)" : ""}`);
  } else if (agentRes.created) {
    console.log(`Created generic agent: ${agentRes.agent_id}`);
  }
  core.applyInfra(config, { from_number: fromNumber, agent_id: agentRes.agent_id, by_lang: core.detectLanguageAgents(agents) });

  // --- 4. Principal identity + standing facts ---
  console.log("\n--- About you (the principal) ---");
  const name = await ask("Your name (used when booking under a name)", config.principal.name);
  const callback = await ask("Callback number (E.164, shared only if a business asks)", config.principal.callback_number);
  core.setPrincipal(config, { name, callback_number: callback });

  console.log("\nStanding facts: durable personal data the agent shares ONLY IF asked");
  console.log("(e.g. service_address, member_id, insurance_provider). A STORE - each");
  console.log("call sends only the minimal relevant subset.");
  config.principal.facts = config.principal.facts || {};
  if (Object.keys(config.principal.facts).length) {
    console.log("Current facts:", Object.keys(config.principal.facts).join(", "));
  }
  if (await askYesNo("Add/edit standing facts now?", false)) {
    const facts = {};
    for (;;) {
      const k = await ask("  fact key (snake_case, blank to finish)");
      if (!k) break;
      const v = await ask(`  value for ${k}`, config.principal.facts[k]);
      if (v) facts[k] = v;
    }
    core.setPrincipal(config, { facts });
  }

  // --- 5. Report-to ---
  console.log("\n--- Where to send call outcomes (optional) ---");
  const existingRt = config.report_to || {};
  if (await askYesNo("Set a default report-to channel?", true)) {
    const ch = (await ask("Channel (email/sms)", existingRt.channel || "email")).toLowerCase();
    const addr = await ask(ch === "sms" ? "SMS number (E.164)" : "Email address", existingRt.address);
    if (ch && addr) config.report_to = { channel: ch, address: addr };
  }

  // --- 6. Write config ---
  core.saveConfig(config);
  console.log(`\nWrote ${core.CONFIG_PATH}.`);
  printStatus();
  console.log("Place a call with:");
  console.log("  node dispatch.js <job.json>          # dry-run read-back");
  console.log("  node dispatch.js <job.json> --go     # actually dial");
  console.log("\n(Only RETELL_API_KEY needs to be in your environment now.)\n");
}

const sub = process.argv[2];
const run = sub === "status" ? async () => printStatus() : wizard;
run()
  .catch((e) => { console.error("\nSetup failed:\n" + (e.message || e)); process.exitCode = 1; })
  .finally(() => { if (rl) rl.close(); });
