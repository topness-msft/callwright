// callwright — MCP server (hosted, single-user).
//
// Streamable HTTP MCP server exposing the call-placing tools. Single-user:
// protected by one bearer token (MCP_AUTH_TOKEN). Your Retell key lives in the
// host env (RETELL_API_KEY) and never leaves the server.
//
// Tools:
//   get_setup_status   - what's configured / missing (drives onboarding)
//   configure          - set identity/facts/report-to (+ optional provisioning)
//   list_scenarios     - known scenario profiles
//   place_call         - DRY-RUN by default; pass confirm:true to actually dial
//   get_call_outcome   - fetch a call's outcome + transcript by id
//   list_recent_calls  - recent calls for this agent/workspace
//   learn_from_call    - enrich a scenario profile from a completed call
//
// Env:
//   RETELL_API_KEY   (required) - Retell secret key
//   MCP_AUTH_TOKEN   (required for remote) - bearer token clients must send
//   PORT             (default 8787)
//   RETELL_FROM_NUMBER / config.json (from-number); agents.json/config (agent)

const express = require("express");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { z } = require("zod");

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");

const core = require("./dispatch-core");
const setup = require("./setup-core");
const paths = require("./paths");

const RETELL_BASE = "https://api.retellai.com";
const PORT = parseInt(process.env.PORT || "8787", 10);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const RETELL_KEY = process.env.RETELL_API_KEY || "";

// ---- helpers ----
const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] });
const errText = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }], isError: true });

async function retell(method, path, body) {
  const opts = { method, headers: { Authorization: `Bearer ${RETELL_KEY}` } };
  if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const resp = await fetch(RETELL_BASE + path, opts);
  const t = await resp.text();
  if (!resp.ok) throw new Error(`Retell ${method} ${path} -> ${resp.status}: ${t}`);
  return t ? JSON.parse(t) : {};
}

function summarizeCall(call) {
  const a = call.call_analysis || {};
  return {
    call_id: call.call_id,
    dashboard: `https://dashboard.retellai.com/call-history?history=${call.call_id}`,
    status: call.call_status,
    disconnect: call.disconnection_reason,
    duration_s: call.duration_ms ? Math.round(call.duration_ms / 1000) : null,
    successful: a.call_successful ?? null,
    summary: a.call_summary || null,
    analysis: a.custom_analysis_data || {},
    transcript: call.transcript || null,
  };
}

// ---- build a fresh McpServer with all tools registered ----
function buildServer() {
  const server = new McpServer(
    { name: "callwright", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "get_setup_status",
    {
      title: "Get setup status",
      description: "Report what callwright has configured (from-number, agent, your name/callback, fact keys) and what's missing. Call this first if you're unsure whether setup is complete; if basics are missing, ask the user for them and call configure.",
      inputSchema: {},
    },
    async () => text(setup.setupStatus())
  );

  server.registerTool(
    "configure",
    {
      title: "Configure principal + (optional) provision infra",
      description: "Save the user's standing profile so calls need less per-call input. Set name and callback_number (the always-safe basics). Optionally save standing facts (durable PII like service_address, member_id — a STORE the LLM later draws minimal subsets from). Set run_provisioning=true to verify the Retell key, pick the phone number, and create the generic agent if missing. Gather values from the user in chat before calling.",
      inputSchema: {
        name: z.string().optional().describe("Name used when a call becomes a booking."),
        callback_number: z.string().optional().describe("E.164. Shared only if a business asks."),
        facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
          .describe("Durable standing facts (snake_case keys). Merged into the store."),
        run_provisioning: z.boolean().optional().describe("If true, verify key + select number + ensure generic agent."),
      },
    },
    async ({ name, callback_number, facts, run_provisioning }) => {
      const config = setup.loadConfig();
      if (run_provisioning) {
        if (!RETELL_KEY) return errText("RETELL_API_KEY is not set on the server; cannot provision.");
        const agents = await setup.verifyKey(RETELL_KEY);
        const res = await setup.resolveFromNumber(RETELL_KEY, config.retell?.from_number);
        if (!res.from_number && res.needsChoice) {
          return errText({
            note: "Could not auto-select a phone number.",
            reason: res.reason,
            numbers: res.numbers.map((n) => n.phone_number),
            instruction: "Tell the user to buy a number (if none) or set RETELL_FROM_NUMBER / config.retell.from_number to one of the listed numbers, then retry.",
          });
        }
        const agentRes = await setup.ensureGenericAgent(RETELL_KEY, { agents, defaultId: config.agents?.default });
        const byLang = setup.detectLanguageAgents(agents);
        setup.applyInfra(config, { from_number: res.from_number, agent_id: agentRes.agent_id, by_lang: byLang });
      }
      setup.setPrincipal(config, { name, callback_number, facts });
      setup.saveConfig(config);
      return text({ saved: true, status: setup.setupStatus(config) });
    }
  );

  server.registerTool(
    "list_scenarios",
    {
      title: "List scenario profiles",
      description: "List known scenario profiles (recommended details, default flexibility, aliases). Use to learn what grounding a given call type benefits from before constructing place_call.",
      inputSchema: {},
    },
    async () => {
      const profiles = setup.loadConfig() && require("fs").existsSync(core.PROFILES_PATH)
        ? JSON.parse(require("fs").readFileSync(core.PROFILES_PATH, "utf8"))
        : {};
      return text(profiles);
    }
  );

  server.registerTool(
    "place_call",
    {
      title: "Place an outbound phone call",
      description:
        "Place a call on the user's behalf. DRY-RUN by default: returns a read-back (including exactly which personal data types will be available to the agent) and does NOT dial. Review it with the user, then call again with confirm:true to actually place the call. DATA MINIMIZATION: in principal.facts include ONLY what THIS call needs; put PII in principal.facts (shared only if asked), not in scenario_details (spoken proactively). For a truly nameless general inquiry set principal.anonymous:true. LANGUAGE: the agent SPEAKS the text fields you provide verbatim. When the call is not in English (set lang accordingly), you MUST write every spoken field in that language — request.summary, request.opening_ask, scenario_details values, preferences, must_confirm, and any constraints. Do NOT write them in English for a non-English call. Fire-and-forget: returns a call_id; read the outcome later with get_call_outcome.",
      inputSchema: {
        call_type: z.string().describe("Open-ended scenario id, e.g. 'haircut', 'restaurant_reservation', 'appointment_confirmation', 'general_inquiry'."),
        target: z.object({
          business_name: z.string(),
          phone_number: z.string().describe("E.164, e.g. +15555550199."),
          timezone: z.string().optional(),
        }),
        principal: z.object({
          name: z.string().optional(),
          callback_number: z.string().optional(),
          anonymous: z.boolean().optional().describe("True = nameless call (general inquiry); suppresses config backfill."),
          facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
            .describe("MINIMAL per-call subset of PII the agent shares only if asked."),
        }).optional(),
        request: z.object({
          summary: z.string().describe("Short internal objective for logging/profiles (e.g. 'Availability inquiry for 2, Fri 18:00'). NOT spoken verbatim — keep it brief; the spoken line is opening_ask."),
          opening_ask: z.string().describe("The exact sentence the agent SPEAKS to state why it's calling. Write a complete, natural, polite sentence in the call's language (Japanese if lang='ja'). It is placed between a warm greeting and the AI disclosure, so do NOT include a greeting or the AI disclosure here — just the purpose/ask. Example (ja): '金曜日18時に2名で空席があるか伺えますでしょうか。' Example (en): 'I'm calling to ask whether you have a table for two this Friday at 6 PM.'"),
          party_size: z.number().int().optional(),
          max_party_size: z.number().int().optional(),
          preferred: z.object({ date: z.string().describe("YYYY-MM-DD"), time: z.string().describe("HH:MM 24h") }),
          acceptable_windows: z.array(z.object({
            date: z.string(), earliest: z.string(), latest: z.string(),
          })).optional(),
        }),
        scenario_details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
          .describe("NON-PII call specifics, spoken proactively (service_type, occasion). No PII here."),
        preferences: z.array(z.string()).optional(),
        constraints: z.array(z.string()).optional(),
        must_confirm: z.array(z.string()).optional(),
        overrides: z.object({
          time_flexibility_minutes: z.number().int().optional(),
          on_voicemail: z.enum(["leave_message", "hang_up", "retry_later"]).optional(),
        }).optional(),
        lang: z.enum(["en", "ja"]).optional().describe("Language to conduct the call in. Set to 'ja' whenever the call should be in Japanese — e.g. the business is in Japan / the phone number starts with +81, or the user asks for Japanese. This routes to the Japanese voice agent AND composes Japanese opening/voicemail text. Default 'en'. If you omit it for a +81 number, the server will assume Japanese."),
        test_to: z.string().optional().describe("Route the actual dial to this number (testing) while keeping the real business number in the read-back."),
        confirm: z.boolean().optional().describe("Must be true to actually dial. Omit/false = dry-run read-back only."),
      },
    },
    async (args) => {
      const { lang: langArg, test_to = null, confirm = false, ...job } = args;
      // Language: use the explicit arg if given; otherwise infer a safe default
      // from the target country code (+81 -> Japanese) so a Japanese call still
      // routes correctly even if the model forgets to set lang. Defaults to en.
      let lang = langArg;
      if (!lang) {
        const num = String(job.target?.phone_number || "");
        lang = num.startsWith("+81") ? "ja" : "en";
      }
      // Onboarding guard before any dialing.
      const guard = setup.guardPlaceCall();
      if (guard && confirm) return errText(guard);

      try {
        const result = await core.placeCall(job, {
          lang, go: confirm, testTo: test_to, key: RETELL_KEY,
        });
        if (!result.ok) return errText({ validation_errors: result.errors });
        if (result.dryRun) {
          return text({
            dry_run: true,
            read_back: result.readback.join("\n"),
            next: "Review with the user. To place this call, call place_call again with the same args plus confirm:true.",
            setup_warning: guard || undefined,
          });
        }
        return text({
          placed: true,
          call_id: result.call.call_id,
          dashboard: `https://dashboard.retellai.com/call-history?history=${result.call.call_id}`,
          read_back: result.readback.join("\n"),
          next: "Fire-and-forget. Use get_call_outcome with this call_id in ~1 minute.",
        });
      } catch (e) {
        return errText(String(e.message || e));
      }
    }
  );

  server.registerTool(
    "get_call_outcome",
    {
      title: "Get call outcome",
      description: "Fetch a call's outcome, post-call analysis, and transcript by call_id. Use after place_call (give it ~30-60s to complete + analyze).",
      inputSchema: { call_id: z.string() },
    },
    async ({ call_id }) => {
      try {
        const call = await retell("GET", `/v2/get-call/${call_id}`);
        return text(summarizeCall(call));
      } catch (e) { return errText(String(e.message || e)); }
    }
  );

  server.registerTool(
    "list_recent_calls",
    {
      title: "List recent calls",
      description: "List recent calls in this Retell workspace (most recent first).",
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ limit = 10 }) => {
      try {
        // v3 list-calls: unified pagination -> read `items` (not a top-level array).
        const resp = await retell("POST", "/v3/list-calls", { limit, sort_order: "descending" });
        const arr = Array.isArray(resp) ? resp : (resp.items || resp.calls || []);
        return text(arr.map((c) => ({
          call_id: c.call_id, status: c.call_status, to: c.to_number,
          when: c.start_timestamp, status_detail: c.call_analysis?.custom_analysis_data?.status,
        })));
      } catch (e) { return errText(String(e.message || e)); }
    }
  );

  server.registerTool(
    "learn_from_call",
    {
      title: "Learn from a call",
      description: "Enrich a scenario profile from a completed call: detect questions the agent had to defer and add them to the profile's recommended details, so future calls collect them up front.",
      inputSchema: {
        call_id: z.string(),
        call_type: z.string().describe("The scenario/profile to enrich (e.g. 'haircut')."),
      },
    },
    async ({ call_id, call_type }) => {
      return new Promise((resolve) => {
        execFile("node", ["learn.js", call_id, call_type], { cwd: __dirname, env: process.env },
          (err, stdout, stderr) => {
            if (err) return resolve(errText((stdout || "") + (stderr || "") + String(err.message)));
            resolve(text(stdout || "Done."));
          });
      });
    }
  );

  return server;
}

// ---- HTTP wiring (Streamable HTTP, session-based) ----
const app = express();
app.use(express.json({ limit: "1mb" }));

// Single-user auth. Accept the token via either the Authorization header
// (Claude Desktop / Cursor / Claude Code / ChatGPT) OR a `?key=` query param
// (claude.ai web, whose connector form only takes a URL). If MCP_AUTH_TOKEN is
// unset, allow only loopback.
function authOk(req) {
  if (!AUTH_TOKEN) {
    const ip = req.ip || req.socket?.remoteAddress || "";
    return ip.includes("127.0.0.1") || ip.includes("::1");
  }
  const h = req.headers["authorization"] || "";
  if (h === `Bearer ${AUTH_TOKEN}`) return true;
  const q = req.query?.key || req.query?.token;
  return q === AUTH_TOKEN;
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "callwright-mcp" }));

// STATELESS MCP: a fresh server + transport per request, no session map.
// This is deliberate — the machine scales to zero and restarts on deploy, and
// an in-memory session map does NOT survive a restart (that caused "worked
// once, then generic error" failures). Stateless means every tool call is
// self-contained, so sleep/restart between calls is irrelevant. Our tools are
// request/response (no long-lived server->client streams), so we lose nothing.
app.post("/mcp", async (req, res) => {
  if (!authOk(req)) {
    return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null });
  }
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { try { transport.close(); server.close(); } catch {} });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("MCP request error:", e?.message || e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    }
  }
});

// In stateless mode there are no sessions to stream/terminate.
app.get("/mcp", (_req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)." }, id: null }));
app.delete("/mcp", (_req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)." }, id: null }));

// Seed mutable state onto the persistent volume on first boot (cross-platform,
// no shell script). config.json + agents.json are created at runtime by
// `configure`; scenario-profiles.json ships with defaults, so seed it.
function seedState() {
  const dataDir = paths.DATA_DIR;
  if (!dataDir || dataDir === ".") return;
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
  const dest = path.join(dataDir, "scenario-profiles.json");
  const src = path.join(__dirname, "scenario-profiles.json");
  if (!fs.existsSync(dest) && fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log("seeded scenario-profiles.json ->", dest);
  }
}

if (require.main === module) {
  seedState();
  if (!RETELL_KEY) console.warn("⚠ RETELL_API_KEY not set — calls will fail until it is.");
  if (!AUTH_TOKEN) console.warn("⚠ MCP_AUTH_TOKEN not set — only loopback clients allowed.");
  app.listen(PORT, () => console.log(`callwright MCP listening on :${PORT} (POST /mcp)`));
}

module.exports = { app, buildServer };
