#!/usr/bin/env node
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
//   list_retries       - recent automatic call retries (no-answer re-dials)
//   configure_notifications - set up optional 'text me when done' SMS
//   learn_from_call    - enrich a profile OR stage a new-scenario candidate
//   list_candidates    - staged scenario candidates (pending new profiles)
//   create_profile     - create a new scenario profile (propose-and-confirm)
//   add_scenario_alias - merge a call_type into an existing profile
//   reject_candidate   - drop a noise/one-off scenario candidate
//   list_voices        - browse Retell voices (for adding a language)
//   list_languages     - languages this server can call in (en base + added)
//   add_language       - add a new call language at runtime (translate -> agent)
//   verify_language    - quality-gate an added language (review card + live call)
//   update_language    - change an added language (prompt/phrases/voice/...)
//   remove_language    - unregister an added language (+ optional agent delete)
//
// Env:
//   RETELL_API_KEY   (required) - Retell secret key
//   MCP_AUTH_TOKEN   (required for remote) - bearer token clients must send
//   PORT             (default 8787)
//   RETELL_FROM_NUMBER / config.json (from-number); agents.json/config (agent)
//   CALLWRIGHT_PUBLIC_URL  (optional) - this server's public URL, used to set the
//                    agents' webhook_url so Retell posts call_analyzed back for
//                    auto-learn (POST /webhook/retell, signature-verified)

const express = require("express");
const fs = require("fs");
const path = require("path");
const { z } = require("zod");

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");

const core = require("./dispatch-core");
const setup = require("./setup-core");
const lang = require("./lang-core");
const learn = require("./learn-core");
const retry = require("./retry-core");
const notify = require("./notify-core");
const outcome = require("./outcome-core");
const paths = require("./paths");

const RETELL_BASE = "https://api.retellai.com";
const PORT = parseInt(process.env.PORT || "8787", 10);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const RETELL_KEY = process.env.RETELL_API_KEY || "";
// Public base URL of THIS server (e.g. https://virtuphil.fly.dev), used to set
// the agents' webhook_url so Retell posts call_analyzed back here for auto-learn.
const PUBLIC_URL = (process.env.CALLWRIGHT_PUBLIC_URL || "").replace(/\/+$/, "");
const WEBHOOK_PATH = "/webhook/retell";

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
    outcome: outcome.resolveOutcome(call),
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

// ---- profile + candidate IO (volume-resident mutable state) ----
function loadProfiles() { try { return JSON.parse(fs.readFileSync(core.PROFILES_PATH, "utf8")); } catch { return {}; } }
function saveProfiles(p) { fs.writeFileSync(core.PROFILES_PATH, JSON.stringify(p, null, 2) + "\n"); }
function loadCandidates() { try { return JSON.parse(fs.readFileSync(paths.CANDIDATES_PATH, "utf8")); } catch { return {}; } }
function saveCandidates(c) { fs.writeFileSync(paths.CANDIDATES_PATH, JSON.stringify(c, null, 2) + "\n"); }
function loadRetries() { try { return JSON.parse(fs.readFileSync(paths.RETRIES_PATH, "utf8")); } catch { return []; } }
function saveRetries(r) { fs.writeFileSync(paths.RETRIES_PATH, JSON.stringify(r, null, 2) + "\n"); }
function appendRetry(entry) {
  const log = loadRetries();
  log.unshift(entry);
  saveRetries(log.slice(0, 200)); // keep the ledger bounded
}
function updateRetry(predicate, patch) {
  const log = loadRetries();
  const i = log.findIndex(predicate);
  if (i >= 0) { log[i] = { ...log[i], ...patch }; saveRetries(log); }
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
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      description: "Report what callwright has configured (from-number, agent, your name/callback, fact keys) and what's missing. Call this first if you're unsure whether setup is complete; if basics are missing, ask the user for them and call configure.",
      inputSchema: {},
    },
    async () => text(setup.setupStatus())
  );

  server.registerTool(
    "configure",
    {
      title: "Configure principal + (optional) provision infra",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description: "Save the user's standing profile so calls need less per-call input. Set name and callback_number (the always-safe basics). Optionally save standing facts (durable PII like service_address, member_id — a STORE the LLM later draws minimal subsets from). This is also the SAVE TARGET for the lazy-save nudge: when place_call returns a save_suggestion (durable facts not yet stored), offer to save them and, if the user agrees, call configure with those facts so they're not re-asked next time. Set run_provisioning=true to verify the Retell key, pick the phone number, and create the generic agent if missing. Gather values from the user in chat before calling.",
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
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      description: "List known scenario profiles (recommended details, default flexibility, aliases). Use to learn what grounding a given call type benefits from before constructing place_call.",
      inputSchema: {},
    },
    async () => {
      const profiles = loadProfiles();
      const candidates = loadCandidates();
      const pending = Object.entries(candidates)
        .map(([name, c]) => ({ scenario: name, seen: c.count, ready: c.count >= 2 && !c.proposed }))
        .filter((c) => c.seen > 0);
      return text({ profiles, pending_candidates: pending.length ? pending : undefined });
    }
  );

  server.registerTool(
    "place_call",
    {
      title: "Place an outbound phone call",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
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
          opening_ask: z.string().trim().min(1).max(180).regex(/^[^\r\n]+$/)
            .describe("The exact short purpose or question spoken after the greeting and before the AI disclosure. Write one question or request only, maximum 180 characters, in the call's language. Do NOT include a greeting, disclosure, background, clarification, transfer request plus substantive question, or second step."),
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
          on_voicemail: z.enum(["leave_message", "hang_up"]).optional().describe("What to do if voicemail answers. Default leave_message. Voicemail is NOT auto-retried."),
          retry: z.object({
            max_retries: z.number().int().min(0).max(5).optional().describe("How many times to RE-DIAL if the call isn't answered. DEFAULT 1. Only set above 1 if the USER specifically asks for more attempts — repeated calls are spammy. Set 0 to disable retry."),
            on: z.array(z.enum(["no_answer", "busy", "failed"])).optional().describe("Which non-answer outcomes trigger a retry. Default ['no_answer','busy','failed']."),
            delay_seconds: z.number().int().min(0).max(600).optional().describe("Best-effort delay before the re-dial (default 60s)."),
          }).optional().describe("Retry-on-no-answer policy. Defaults to exactly 1 retry; do not raise max_retries without an explicit user request."),
        }).optional(),
        notify: z.object({
          sms: z.boolean().optional().describe("Set true ONLY if the user asks to be notified/texted when this call is done. Default false — results are pulled on demand via get_call_outcome."),
          to: z.string().optional().describe("The USER'S OWN number to text (E.164). If omitted, the saved notify number is used; if none is saved, ask the user for their number first."),
        }).optional().describe("Optional per-call 'text me when it's done'. Off by default (pull-based)."),
        lang: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "must be a BCP-47 language code, e.g. 'en', 'ja', 'fr', 'zh-CN'").optional().describe("Language to conduct the call in, as a BCP-47 code (e.g. 'en', 'ja', 'fr'). The call routes to the matching language agent (registered in config.agents.by_lang) and composes opening/voicemail text in that language. Currently fully supported: 'en' and 'ja'; other codes only work once a language agent has been added for them (see add_language). Default 'en'. If you omit it for a +81 number, the server assumes 'ja'."),
        test_to: z.string().optional().describe("Route the actual dial to this number (testing) while keeping the real business number in the read-back."),
        agent_version: z.union([z.number().int().min(0), z.string().min(1).max(20)]).optional()
          .describe("Advanced testing/admin option: pin this call to an exact Retell agent version or tag. Omit for normal calls."),
        confirm: z.boolean().optional().describe("Must be true to actually dial. Omit/false = dry-run read-back only."),
      },
    },
    async (args) => {
      const { lang: langArg, test_to = null, agent_version = null, confirm = false, ...job } = args;
      // Language: use the explicit arg if given; otherwise infer a safe default
      // from the target country code (+81 -> Japanese) so a Japanese call still
      // routes correctly even if the model forgets to set lang. Defaults to en.
      let lang = langArg;
      if (!lang) {
        const num = String(job.target?.phone_number || "");
        lang = num.startsWith("+81") ? "ja" : "en";
      }
      // A language is supported if it's English (the default agent) or a language
      // agent is registered for it. Guard against silently dialing a non-English
      // call with the English agent (the enum is now open to any BCP-47 code).
      const cfg = setup.loadConfig();
      const langSupported =
        lang === "en" || Boolean(cfg.agents?.by_lang?.[lang.toLowerCase().split("-")[0]]);
      const langWarning = langSupported ? undefined : {
        unsupported_language: lang,
        note: `No language agent is registered for "${lang}". The call would run with the English agent. Add the language first (see add_language) or choose a supported language (en, ja).`,
      };
      // Resolve the SMS-notify target up-front so it round-trips with the call and
      // shows in the read-back. Falls back to the saved notify number / callback.
      let notifyWarning;
      if (job.notify?.sms) {
        const to = job.notify.to || cfg.notify?.sms?.to || cfg.principal?.callback_number || "";
        job.notify = { sms: true, to };
        if (!to) notifyWarning = "notify.sms was requested but no number is known — ask the user for their mobile number (or pass notify.to).";
      }
      // Lazy-save nudge: durable facts on this call not yet in the standing
      // profile, so the LLM can offer to save them once (configure) — never
      // re-asking next time. Pure check against config; no PII values echoed.
      const unsaved = setup.unsavedDurableFacts(job, cfg);
      const saveSuggestion = unsaved.length ? {
        unsaved_facts: unsaved,
        instruction: "After this call, offer to save the DURABLE items (e.g. name, callback_number, service_address, member_id) to the user's profile via configure, so they aren't re-entered next time. Skip anything that's specific to this one call. Only save with the user's ok.",
      } : undefined;
      // Onboarding guard before any dialing.
      const guard = setup.guardPlaceCall();
      if (guard && confirm) return errText(guard);
      // Refuse to actually dial an unsupported language (would be the wrong agent).
      if (langWarning && confirm) return errText(langWarning);

      try {
        const result = await core.placeCall(job, {
          lang, go: confirm, testTo: test_to, agentVersion: agent_version, key: RETELL_KEY,
        });
        if (!result.ok) return errText({ validation_errors: result.errors });
        if (result.dryRun) {
          return text({
            dry_run: true,
            read_back: result.readback.join("\n"),
            next: "Review with the user. To place this call, call place_call again with the same args plus confirm:true.",
            setup_warning: guard || undefined,
            language_warning: langWarning,
            notify_warning: notifyWarning,
            save_suggestion: saveSuggestion,
          });
        }
        return text({
          placed: true,
          call_id: result.call.call_id,
          dashboard: `https://dashboard.retellai.com/call-history?history=${result.call.call_id}`,
          read_back: result.readback.join("\n"),
          next: "Fire-and-forget. Use get_call_outcome with this call_id in ~1 minute.",
          save_suggestion: saveSuggestion,
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
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description: "Fetch a call's outcome, post-call analysis, and transcript by call_id. The `outcome` object is authoritative when Retell's raw success boolean conflicts with custom analysis. Use after place_call (give it ~30-60s to complete + analyze).",
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
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description: "List recent calls in this Retell workspace (most recent first).",
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ limit = 10 }) => {
      try {
        // v3 list-calls: unified pagination -> read `items` (not a top-level array).
        const resp = await retell("POST", "/v3/list-calls", { limit, sort_order: "descending" });
        const arr = Array.isArray(resp) ? resp : (resp.items || resp.calls || []);
        return text(arr.map((c) => ({
          outcome: outcome.resolveOutcome(c),
          call_id: c.call_id, status: c.call_status, to: c.to_number,
          when: c.start_timestamp, status_detail: c.call_analysis?.custom_analysis_data?.status,
        })));
      } catch (e) { return errText(String(e.message || e)); }
    }
  );

  server.registerTool(
    "list_retries",
    {
      title: "List call retries",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      description: "Show recent automatic call retries (no-answer/busy/failed re-dials), most recent first. Retries default to at most 1 per call and never auto-escalate. Each entry shows the original call, the attempt number/cap, the new call_id (if placed), and status (scheduled/placed/failed).",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ limit = 20 }) => {
      const log = loadRetries().slice(0, limit);
      return text({ retries: log, note: log.length ? undefined : "No retries yet." });
    }
  );

  server.registerTool(
    "configure_notifications",
    {
      title: "Configure SMS notifications",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: "Set up the optional 'text me when the call is done' feature. Saves the user's mobile number as the default notify target, provisions the one-time SMS summary agent if needed, and (with test:true) sends a test SMS now so the user can confirm delivery. Per-call SMS is still opt-in via place_call notify.sms — this just stores the number + infra. NOTE: the Retell from-number must be SMS-capable (KYC-gated).",
      inputSchema: {
        sms_to: z.string().optional().describe("The user's mobile number (E.164) to text by default."),
        from_number: z.string().optional().describe("Override the SMS from-number (defaults to the call from-number). Must be SMS-capable."),
        provision: z.boolean().optional().describe("If true, create the SMS summary agent now (otherwise it's created lazily on first send)."),
        test: z.boolean().optional().describe("If true, send a test SMS to sms_to right now to verify delivery."),
      },
    },
    async ({ sms_to, from_number, provision, test: doTest }) => {
      if (!RETELL_KEY) return errText("RETELL_API_KEY is not set on the server.");
      const config = setup.loadConfig();
      config.notify = config.notify || {};
      config.notify.sms = config.notify.sms || {};
      if (sms_to) config.notify.sms.to = sms_to;
      if (from_number) config.notify.sms.from_number = from_number;
      try {
        if (provision || doTest) {
          const api = (m, p, b) => setup.apiCall(RETELL_KEY, m, p, b);
          await notify.ensureSmsAgent(api, config.notify.sms);
        }
        setup.saveConfig(config);
        let test_result;
        if (doTest) {
          const to = sms_to || config.notify.sms.to;
          if (!to) return errText("Provide sms_to to send a test.");
          const fakeCall = {
            call_id: "test_notification",
            to_number: "+10000000000",
            retell_llm_dynamic_variables: { business_name: "Callwright", objective: "notification test" },
            call_analysis: { call_successful: true, custom_analysis_data: { status: "completed" } },
          };
          const r = await notify.notifyCall(fakeCall, { config, key: RETELL_KEY, to, force: true });
          if (r.configChanged) setup.saveConfig(config);
          test_result = r.sent ? { sent: true, to: r.to, preview: r.summary } : { sent: false, reason: r.reason, error: r.error, hint: r.hint };
        }
        return text({
          saved: true,
          notify_sms: { to: config.notify.sms.to || null, from_number: config.notify.sms.from_number || config.retell?.from_number || null, agent_provisioned: !!config.notify.sms.chat_agent_id },
          test_result,
          note: "Per-call SMS is opt-in: set notify.sms:true on place_call (e.g. 'text me when it's done').",
        });
      } catch (e) { return errText(String(e.message || e)); }
    }
  );

  server.registerTool(
    "learn_from_call",
    {
      title: "Learn from a call",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: "Improve the system from a completed call. If the call_type matches a profile, it's ENRICHED (deferred questions become recommended_details, value-baked ones rejected). If it has NO profile, the (generalized) scenario is STAGED as a candidate; once seen >=2 times it becomes a PROPOSAL you can review and create via create_profile. Creation is never silent — it's proposed for you to approve (or merge into an existing profile with add_scenario_alias).",
      inputSchema: {
        call_id: z.string(),
        call_type: z.string().describe("The scenario id for this call (e.g. 'haircut', 'hotel_transport_inquiry')."),
      },
    },
    async ({ call_id, call_type }) => {
      try {
        const call = await retell("GET", `/v2/get-call/${call_id}`);
        const profiles = loadProfiles();
        const candidates = loadCandidates();
        // Explicit/manual learning is trusted: promote a field on first sight.
        const r = learn.applyLearning(call, { profiles, candidates, callType: call_type, minCount: 1, N: 2 });
        if (r.mode === "skip") {
          return text({ learned: false, reason: r.reason, note: r.reason === "no_gaps" ? "No unanswered-question gaps detected. Nothing to learn." : "No call_type to learn against." });
        }
        if (r.mode === "enriched") {
          saveProfiles(profiles);
          return text({
            mode: "enriched", profile: r.profile, gaps: r.gaps, added_fields: r.added,
            note: r.added.length ? `Future ${r.profile} calls will collect: ${r.added.join(", ")}.` : "No new fields (already covered or value-baked).",
          });
        }
        // staged
        saveCandidates(candidates);
        const out = {
          mode: "staged", scenario: r.scenario, generalized_from: r.generalized_from,
          gaps: r.gaps, seen: r.seen, ready_to_propose: r.ready_to_propose,
        };
        if (r.ready_to_propose) {
          out.proposal = r.proposal;
          out.next = "Review the proposal. If it's a genuinely new scenario, call create_profile to add it. If it's really the same as an existing profile, call add_scenario_alias instead (merge, don't splinter).";
        } else {
          out.next = `Seen ${r.seen}x; will propose once seen >=2 times. (Anti-noise guard.)`;
        }
        return text(out);
      } catch (e) { return errText(String(e.message || e)); }
    }
  );

  server.registerTool(
    "list_candidates",
    {
      title: "List scenario candidates",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      description: "Show staged scenario candidates (unmatched call types seen but not yet a profile) with their occurrence counts, variant names, and the questions agents had to defer. Candidates seen >=2 times are 'ready' to propose as a new profile (create_profile) or merge into an existing one (add_scenario_alias).",
      inputSchema: {},
    },
    async () => {
      const candidates = loadCandidates();
      const view = Object.entries(candidates).map(([name, c]) => ({
        scenario: name,
        seen: c.count,
        ready: c.count >= 2 && !c.proposed,
        proposed: !!c.proposed,
        variants: c.variants,
        deferred_fields: Object.fromEntries(Object.entries(c.questions || {}).map(([k, q]) => [k, { count: q.count, mapped: q.mapped }])),
        examples: c.examples,
      }));
      return text({ candidates: view, note: view.length ? undefined : "No candidates staged yet." });
    }
  );

  server.registerTool(
    "create_profile",
    {
      title: "Create a scenario profile",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "Create a NEW scenario profile (propose-and-confirm — call this only after reviewing a learn_from_call proposal with the user). GUARDS: the name must be a GENERAL scenario (not instance-shaped like 'dinner_for_2'); recommended_details must be GENERALIZED field keys ('destination', not 'destination_haneda') — values belong in the per-call job, never the profile. If the scenario is really the same as an existing profile, use add_scenario_alias instead. Clears the matching candidate on success.",
      inputSchema: {
        name: z.string().describe("snake_case general scenario id, e.g. 'hotel_transport_inquiry'."),
        recommended_details: z.record(z.string(), z.string()).describe("Map of generalized field key -> human description of what to collect (schema, NOT values)."),
        aliases: z.array(z.string()).optional().describe("Alternate names that should match this scenario (e.g. 'hire_car', 'airport_transfer')."),
        default_flex_minutes: z.number().int().optional().describe("Default +/- time flexibility for this scenario."),
        must_confirm: z.array(z.string()).optional().describe("Fields to read back at the end of a booking."),
      },
    },
    async ({ name, recommended_details, aliases = [], default_flex_minutes, must_confirm }) => {
      const profiles = loadProfiles();
      const v = learn.validateNewProfile(name, profiles, recommended_details || {});
      if (v.collision) return errText({ error: `"${name}" already maps to profile "${v.collision}". Use add_scenario_alias to merge instead of creating a duplicate.` });
      if (!v.ok) return errText({ error: "Profile rejected by anti-splintering guards.", details: v.errors });
      const n = name.toLowerCase().trim();
      const profile = { recommended_details: recommended_details || {} };
      if (aliases.length) profile.aliases = aliases.map((a) => a.toLowerCase());
      if (typeof default_flex_minutes === "number") profile.default_flex_minutes = default_flex_minutes;
      if (must_confirm && must_confirm.length) profile.must_confirm = must_confirm;
      profiles[n] = profile;
      saveProfiles(profiles);
      // Clear the candidate (by generalized name) now that it's a real profile.
      const candidates = loadCandidates();
      const { general } = learn.generalizeCallType(n);
      let cleared = false;
      for (const key of [n, general]) { if (candidates[key]) { delete candidates[key]; cleared = true; } }
      if (cleared) saveCandidates(candidates);
      return text({ created: true, profile: n, recommended_details: profile.recommended_details, aliases: profile.aliases || [], candidate_cleared: cleared });
    }
  );

  server.registerTool(
    "add_scenario_alias",
    {
      title: "Add an alias to a scenario profile",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "Merge a call_type into an EXISTING profile by adding it as an alias (the anti-splintering 'merge, don't create' path). Use when a candidate / new call_type is really the same scenario as a profile you already have. Clears the matching candidate.",
      inputSchema: {
        profile: z.string().describe("The existing profile to merge into (e.g. 'hotel_transport_inquiry')."),
        alias: z.string().describe("The call_type / name to add as an alias (e.g. 'hire_car')."),
      },
    },
    async ({ profile, alias }) => {
      const profiles = loadProfiles();
      const key = learn.matchProfile(profiles, profile) || (profiles[String(profile).toLowerCase()] ? String(profile).toLowerCase() : null);
      if (!key) return errText({ error: `No profile "${profile}" found. Use list_scenarios to see existing profiles, or create_profile to make a new one.` });
      const a = String(alias).toLowerCase().trim();
      const prof = profiles[key];
      prof.aliases = prof.aliases || [];
      if (!prof.aliases.includes(a) && a !== key) prof.aliases.push(a);
      saveProfiles(profiles);
      const candidates = loadCandidates();
      const { general } = learn.generalizeCallType(a);
      let cleared = false;
      for (const k of [a, general]) { if (candidates[k]) { delete candidates[k]; cleared = true; } }
      if (cleared) saveCandidates(candidates);
      return text({ merged: true, profile: key, aliases: prof.aliases, candidate_cleared: cleared });
    }
  );

  server.registerTool(
    "reject_candidate",
    {
      title: "Reject a scenario candidate",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      description: "Discard a staged scenario candidate that is noise or a one-off (not a real recurring scenario). Removes it from the candidates store.",
      inputSchema: { scenario: z.string().describe("The candidate scenario name to drop (from list_candidates).") },
    },
    async ({ scenario }) => {
      const candidates = loadCandidates();
      const key = candidates[scenario] ? scenario : learn.generalizeCallType(scenario).general;
      if (!candidates[key]) return errText({ error: `No candidate "${scenario}".` });
      delete candidates[key];
      saveCandidates(candidates);
      return text({ rejected: true, scenario: key });
    }
  );

  server.registerTool(
    "list_voices",
    {
      title: "List Retell voices",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description: "List available Retell voices (for picking a voice when adding a language). Optionally filter by accent (e.g. 'French', 'Japanese') or a free-text query (name/provider/accent). NOTE: Retell voices have an accent, not a hard language field, and most are multilingual — accent is a hint, not a guarantee. Validate the final choice with a verification call.",
      inputSchema: {
        accent: z.string().optional().describe("Filter by accent substring, e.g. 'French', 'Spanish', 'Japanese'."),
        query: z.string().optional().describe("Free-text filter over voice name / provider / accent."),
        limit: z.number().int().positive().optional().describe("Max voices to return (default 40)."),
      },
    },
    async ({ accent, query, limit }) => {
      if (!RETELL_KEY) return errText("RETELL_API_KEY is not set on the server.");
      const r = await lang.listVoices(RETELL_KEY, { accent, query, limit });
      return r.error ? errText(r) : text(r);
    }
  );

  server.registerTool(
    "list_languages",
    {
      title: "List call languages",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      description: "List the call languages this server can conduct calls in: the built-in English base plus any added languages (with their agent, voice, Retell language code, and whether prompt/phrase assets are on the volume). Use to see what's available before place_call or add_language.",
      inputSchema: {},
    },
    async () => text(lang.listLanguages(setup.loadConfig()))
  );

  server.registerTool(
    "add_language",
    {
      title: "Add a call language",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: "Add a NEW call language at runtime (no redeploy). Two-phase: call with just lang + display_name to get back the base prompt + English phrase block to TRANSLATE; then call again with prompt_text + phrases (translated, preserving every {{variable}} and {placeholder}) to create the language agent. Pick a native-accent voice_id via list_voices (optional — defaults to the English house voice, which you should override for best quality). English cannot be added (it's the built-in base). After it succeeds, run a verification call before production.",
      inputSchema: {
        lang: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "BCP-47 code, e.g. 'fr', 'es', 'pt-BR'").describe("BCP-47 language code to add (e.g. 'fr', 'es', 'de', 'pt-BR')."),
        display_name: z.string().describe("Human name of the language, e.g. 'French'."),
        prompt_text: z.string().optional().describe("The FULL agent prompt translated into the new language. Omit on the first call to receive the base prompt to translate. Must keep all {{variables}}."),
        phrases: z.record(z.string(), z.any()).optional().describe("The translated phrase block (same keys as the returned base_phrases). Omit on the first call. Must keep all {placeholder} tokens."),
        voice_id: z.string().optional().describe("A Retell voice_id that suits the language (from list_voices). Defaults to the English house voice if omitted — override for native quality."),
        language: z.string().optional().describe("Retell agent language code override (e.g. 'fr-CA'). Defaults to a sensible value for the language."),
        stt_mode: z.string().optional().describe("Speech-to-text mode (default 'accurate')."),
        interruption_sensitivity: z.number().min(0).max(1).optional().describe("0..1 (default 0.5; lower = less likely to interrupt, like Japanese)."),
      },
    },
    async (args) => {
      if (!RETELL_KEY) return errText("RETELL_API_KEY is not set on the server; cannot add a language.");
      const r = await lang.addLanguage(RETELL_KEY, args);
      return r.error ? errText(r) : text(r);
    }
  );

  server.registerTool(
    "verify_language",
    {
      title: "Verify a call language",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: "Quality-gate a newly added language before production. DRY-RUN by default: returns a review card with the EXACT spoken opening (greeting + your ask + AI disclosure) and voicemail message — composed by the language's agent — plus a native-review checklist. To HEAR it live, pass to:<your phone> and confirm:true and the agent will call you so you can judge accent, etiquette, and the disclosure by ear. For the truest review, pass target-language sample_summary and sample_opening_ask.",
      inputSchema: {
        lang: z.string().describe("The registered language code to verify (e.g. 'fr')."),
        sample_summary: z.string().optional().describe("A sample call objective IN THE TARGET LANGUAGE (improves the review fidelity)."),
        sample_opening_ask: z.string().optional().describe("A sample spoken opening ask IN THE TARGET LANGUAGE. If omitted, the language's own fallback phrasing is used."),
        to: z.string().optional().describe("Your own phone number (E.164) to receive the live verification call. Defaults to your configured callback_number."),
        confirm: z.boolean().optional().describe("Must be true (with a resolvable 'to') to actually place the live call. Omit = dry-run review card only."),
      },
    },
    async ({ lang: langArg, sample_summary, sample_opening_ask, to, confirm = false }) => {
      if (!RETELL_KEY) return errText("RETELL_API_KEY is not set on the server.");
      const { primary, valid } = lang.normalizeLang(langArg);
      if (!valid) return errText(`Invalid language code "${langArg}".`);
      const config = setup.loadConfig();
      const meta = config.languages?.[primary];
      const agentId = config.agents?.by_lang?.[primary] || meta?.agent_id;
      if (primary !== "en" && !agentId) {
        return errText(`Language "${primary}" is not registered. Add it first with add_language.`);
      }
      const job = lang.buildVerificationJob(primary, { sample_summary, sample_opening_ask });
      let result;
      try {
        result = await core.placeCall(job, { lang: primary, go: false, key: RETELL_KEY });
      } catch (e) { return errText(String(e.message || e)); }
      if (!result.ok) return errText({ validation_errors: result.errors });
      const card = lang.verificationCard(result.composed, {
        lang: primary,
        display_name: meta?.display_name || primary,
        agent_id: agentId || result.agentId,
        voice_id: meta?.voice_id || null,
        language: meta?.language || null,
      });

      const dialTo = to || config.principal?.callback_number || null;
      if (!confirm) {
        return text({
          review: card,
          live_call: dialTo
            ? `To hear it, call verify_language again with to:"${dialTo}" and confirm:true.`
            : "To hear it live, provide to:<your phone> and confirm:true (no callback_number is configured).",
        });
      }
      if (!dialTo) return errText("No 'to' number provided and no callback_number configured; cannot place the live verification call.");
      try {
        const dial = await core.placeCall(
          { ...job, target: { business_name: "Verification call", phone_number: dialTo } },
          { lang: primary, go: true, key: RETELL_KEY }
        );
        return text({
          review: card,
          placed: true,
          call_id: dial.call.call_id,
          to: dialTo,
          next: "Answer the call and judge the opening, AI disclosure, accent, and etiquette by ear. Fetch the transcript with get_call_outcome. Fix anything via update_language.",
        });
      } catch (e) { return errText(String(e.message || e)); }
    }
  );

  server.registerTool(
    "update_language",
    {
      title: "Update a call language",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description: "Change an already-added language: replace its prompt_text and/or phrases (re-translated), and/or change its voice_id, Retell language code, interruption_sensitivity, or stt_mode. Only the provided fields change. Use list_languages to see what's registered.",
      inputSchema: {
        lang: z.string().describe("The registered language code to update (e.g. 'fr')."),
        prompt_text: z.string().optional().describe("Replacement prompt (must keep all {{variables}})."),
        phrases: z.record(z.string(), z.any()).optional().describe("Replacement phrase block (must keep all {placeholder} tokens)."),
        voice_id: z.string().optional().describe("New Retell voice_id (validated against list_voices)."),
        language: z.string().optional().describe("New Retell language code."),
        interruption_sensitivity: z.number().min(0).max(1).optional(),
        stt_mode: z.string().optional(),
      },
    },
    async (args) => {
      if (!RETELL_KEY) return errText("RETELL_API_KEY is not set on the server.");
      const r = await lang.updateLanguage(RETELL_KEY, args);
      return r.error ? errText(r) : text(r);
    }
  );

  server.registerTool(
    "remove_language",
    {
      title: "Remove a call language",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      description: "Unregister an added language and delete its volume prompt + phrase assets. By default the Retell agent is LEFT in your dashboard (set delete_agent:true to delete it too). English cannot be removed.",
      inputSchema: {
        lang: z.string().describe("The registered language code to remove (e.g. 'fr')."),
        delete_agent: z.boolean().optional().describe("If true, also delete the Retell agent + LLM. Default false (unregister locally only)."),
      },
    },
    async (args) => {
      if (!RETELL_KEY) return errText("RETELL_API_KEY is not set on the server.");
      const r = await lang.removeLanguage(RETELL_KEY, args);
      return r.error ? errText(r) : text(r);
    }
  );

  return server;
}
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

// ---- Retell webhook -> AUTO-LEARN (deterministic; no MCP auth, signature-verified) ----
// When Retell finishes analyzing a call it POSTs here. We run the SAME learning
// heuristics as the learn_from_call tool, but autonomously and with the stricter
// minCount:2 promotion guard (a field must recur before it's added; a new
// scenario only ever STAGES — creation stays a propose-and-confirm human step).
function verifyRetellWebhook(req) {
  if (process.env.WEBHOOK_SKIP_VERIFY === "1") return true;
  try {
    const Retell = require("retell-sdk").Retell || require("retell-sdk").default || require("retell-sdk");
    const sig = req.headers["x-retell-signature"];
    return Retell.verify(JSON.stringify(req.body), RETELL_KEY, sig);
  } catch (e) {
    console.error("webhook signature verify failed:", e.message);
    return false;
  }
}

app.post(WEBHOOK_PATH, async (req, res) => {
  if (!verifyRetellWebhook(req)) return res.status(401).json({ error: "invalid signature" });
  const { event, call } = req.body || {};

  // ---- call_ended -> retry-on-no-answer (deterministic, bounded) ----
  // Default policy is exactly 1 retry; the attempt counter rides in the call's
  // dynamic vars so the chain self-terminates and we never exceed max_retries.
  if (event === "call_ended") {
    try {
      const d = retry.decideRetry(call);
      if (!d.retry) return res.status(200).json({ retry: false, reason: d.reason, category: d.category });
      const entry = {
        at: new Date().toISOString(),
        parent_call_id: call.call_id,
        to: call.to_number,
        business: call.retell_llm_dynamic_variables?.business_name || call.to_number,
        category: d.category,
        attempt: d.attempt,
        max_retries: d.maxRetries,
        delay_seconds: d.delaySeconds,
        status: "scheduled",
      };
      appendRetry(entry);
      // Best-effort delayed re-dial while the machine is warm (scale-to-zero may
      // drop a pending timer; that's the accepted tradeoff for no extra infra).
      const fire = async () => {
        try {
          const newCall = await core.redialFromCall(call, { key: RETELL_KEY, attempt: d.attempt });
          updateRetry((e) => e.parent_call_id === entry.parent_call_id && e.attempt === entry.attempt && e.status === "scheduled",
            { status: "placed", new_call_id: newCall.call_id });
          console.log(`retry placed: ${call.call_id} -> ${newCall.call_id} (attempt ${d.attempt}/${d.maxRetries}, ${d.category})`);
        } catch (e) {
          updateRetry((x) => x.parent_call_id === entry.parent_call_id && x.attempt === entry.attempt && x.status === "scheduled",
            { status: "failed", error: e.message });
          console.error("retry redial failed:", e.message);
        }
      };
      if (d.delaySeconds > 0) setTimeout(fire, d.delaySeconds * 1000).unref?.();
      else fire();
      return res.status(200).json({ retry: true, attempt: d.attempt, max_retries: d.maxRetries, in_seconds: d.delaySeconds, category: d.category });
    } catch (e) {
      console.error("retry handler error:", e.message);
      return res.status(200).json({ retry: false, error: e.message });
    }
  }

  if (event !== "call_analyzed") return res.status(200).json({ skipped: event || "no_event" });

  // SMS notify (per-call opt-in) — independent of learning. Fire-and-respond:
  // we don't block the 200 on it, but we persist any provisioned agent to config.
  const notifyResult = (async () => {
    try {
      if (!notify.shouldNotify(call).notify) return { sent: false, reason: "not_requested" };
      const config = setup.loadConfig();
      const r = await notify.notifyCall(call, { config, key: RETELL_KEY });
      if (r.configChanged) setup.saveConfig(config);
      if (r.sent) console.log(`SMS notify sent to ${r.to} for call ${call.call_id}`);
      else console.log(`SMS notify skipped (${r.reason}${r.error ? ": " + r.error : ""})`);
      return r;
    } catch (e) { console.error("notify error:", e.message); return { sent: false, error: e.message }; }
  })();

  try {
    const profiles = loadProfiles();
    const candidates = loadCandidates();
    const r = learn.applyLearning(call, { profiles, candidates, minCount: 2, N: 2 });
    const notified = await notifyResult;
    const notify_sms = notified.sent ? { sent: true, to: notified.to } : (notified.reason === "not_requested" ? undefined : { sent: false, reason: notified.reason, error: notified.error });
    if (r.mode === "enriched") {
      if (!r.skipped) saveProfiles(profiles);
      return res.status(200).json({ auto_learned: "enriched", profile: r.profile, added: r.added, skipped: r.skipped || false, notify_sms });
    }
    if (r.mode === "staged") {
      saveCandidates(candidates);
      return res.status(200).json({ auto_learned: "staged", scenario: r.scenario, seen: r.seen, ready_to_propose: r.ready_to_propose, notify_sms });
    }
    return res.status(200).json({ auto_learned: false, reason: r.reason, notify_sms });
  } catch (e) {
    console.error("auto-learn error:", e.message);
    await notifyResult;
    return res.status(200).json({ auto_learned: false, error: e.message }); // 200 so Retell doesn't retry forever
  }
});

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
