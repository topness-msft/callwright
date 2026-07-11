// Tests for setup-core.unsavedDurableFacts (lazy-save fact nudge).
const test = require("node:test");
const assert = require("node:assert");
const setup = require("../setup-core.js");

const job = (principal) => ({ call_type: "x", principal });

test("anonymous call -> no suggestions", () => {
  assert.deepEqual(setup.unsavedDurableFacts(job({ anonymous: true, facts: { service_address: "1 Main St" } }), {}), []);
});

test("new durable fact not in profile -> suggested as new", () => {
  const r = setup.unsavedDurableFacts(job({ facts: { service_address: "1 Main St" } }), { principal: {} });
  assert.deepEqual(r, [{ key: "service_address", type: "new" }]);
});

test("fact already saved with same value -> not suggested", () => {
  const r = setup.unsavedDurableFacts(job({ facts: { service_address: "1 Main St" } }), { principal: { facts: { service_address: "1 Main St" } } });
  assert.deepEqual(r, []);
});

test("fact saved but value changed -> suggested as changed", () => {
  const r = setup.unsavedDurableFacts(job({ facts: { service_address: "2 New Rd" } }), { principal: { facts: { service_address: "1 Main St" } } });
  assert.deepEqual(r, [{ key: "service_address", type: "changed" }]);
});

test("ephemeral keys (confirmation/otp) are never suggested", () => {
  const r = setup.unsavedDurableFacts(job({ facts: { confirmation_number: "ABC123", otp: "9999", member_id: "M-1" } }), { principal: {} });
  assert.deepEqual(r.map((x) => x.key), ["member_id"]);
});

test("name + callback offered when not in profile, skipped when present", () => {
  const r1 = setup.unsavedDurableFacts(job({ name: "Alex", callback_number: "+15710001111" }), { principal: {} });
  assert.deepEqual(r1.map((x) => x.key).sort(), ["callback_number", "name"]);
  const r2 = setup.unsavedDurableFacts(job({ name: "Alex", callback_number: "+15710001111" }), { principal: { name: "Alex", callback_number: "+15710001111" } });
  assert.deepEqual(r2, []);
});

test("empty/blank fact values are ignored", () => {
  const r = setup.unsavedDurableFacts(job({ facts: { service_address: "", member_id: null } }), { principal: {} });
  assert.deepEqual(r, []);
});

test("no principal / no facts -> no suggestions", () => {
  assert.deepEqual(setup.unsavedDurableFacts({ call_type: "x" }, {}), []);
  assert.deepEqual(setup.unsavedDurableFacts(job({}), {}), []);
});

test("post-call analysis distinguishes informational completion from booking", () => {
  const status = setup.POST_CALL_ANALYSIS.find((field) => field.name === "status");
  assert.ok(status);
  assert.ok(status.choices.includes("completed"));
  assert.match(status.description, /booked.*actual.*reservation|appointment|commitment/i);
  assert.match(status.description, /completed.*reliable.*information/i);
});

test("Retell built-in success is aligned to objective completion", () => {
  const preset = setup.POST_CALL_ANALYSIS.find(
    (field) => field.type === "system-presets" && field.name === "call_successful"
  );
  assert.ok(preset);
  assert.match(preset.description, /connected call alone is not successful/i);
  assert.match(preset.description, /misunderstood|adjacent answer/i);
});

test("post-call analysis migration is focused and idempotent", () => {
  assert.equal(
    setup.buildPostCallAnalysisPatch({ post_call_analysis_data: setup.POST_CALL_ANALYSIS }),
    null
  );

  const patch = setup.buildPostCallAnalysisPatch({
    agent_id: "agent_1",
    voice_id: "voice_1",
    post_call_analysis_data: [{ type: "enum", name: "status", choices: ["booked", "failed"] }],
  });
  assert.deepEqual(Object.keys(patch), ["post_call_analysis_data"]);
  assert.deepEqual(patch.post_call_analysis_data, setup.POST_CALL_ANALYSIS);
});

test("post-call analysis migration preserves unknown custom fields", () => {
  const customField = { type: "string", name: "custom_metric", description: "Keep me." };
  const patch = setup.buildPostCallAnalysisPatch({
    post_call_analysis_data: [
      { type: "enum", name: "status", choices: ["booked", "failed"] },
      customField,
    ],
  });

  assert.ok(patch.post_call_analysis_data.includes(customField));
  assert.deepEqual(
    patch.post_call_analysis_data.filter((field) => field.name === "custom_metric"),
    [customField]
  );
});

test("prompt and analysis migration dry-run writes nothing; apply is focused and idempotent", async () => {
  let agent = {
    agent_id: "agent_1",
    version: 3,
    is_published: false,
    voice_id: "voice_keep",
    webhook_url: "https://keep.example/webhook",
    webhook_events: ["call_started"],
    response_engine: { type: "retell-llm", llm_id: "llm_1", version: 7 },
    post_call_analysis_data: [{ type: "enum", name: "status", choices: ["booked", "failed"] }],
  };
  let llm = {
    llm_id: "llm_1",
    version: 7,
    general_prompt: "old prompt",
    general_tools: [{ type: "end_call", name: "end_call" }],
    start_speaker: "agent",
  };
  const calls = [];
  const api = async (_key, method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path === "/get-agent/agent_1?version=3") return structuredClone(agent);
    if (method === "GET" && path === "/get-retell-llm/llm_1?version=7") return structuredClone(llm);
    if (method === "PATCH" && path === "/update-retell-llm/llm_1?version=7") {
      llm = { ...llm, ...structuredClone(body) };
      return structuredClone(llm);
    }
    if (method === "PATCH" && path === "/update-agent/agent_1?version=3") {
      agent = { ...agent, ...structuredClone(body) };
      return structuredClone(agent);
    }
    throw new Error(`${method} ${path}`);
  };

  const dry = await setup.syncPromptAndAnalysis("key", "agent_1", "new prompt", {
    api,
    dryRun: true,
    agentVersion: 3,
  });
  assert.equal(dry.applied, false);
  assert.deepEqual(dry.changes, {
    llm: ["general_prompt"],
    agent: ["post_call_analysis_data"],
  });
  assert.equal(calls.some((call) => call.method === "PATCH"), false);

  calls.length = 0;
  const applied = await setup.syncPromptAndAnalysis("key", "agent_1", "new prompt", {
    api,
    agentVersion: 3,
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.verified, true);
  const writes = calls.filter((call) => call.method === "PATCH");
  assert.deepEqual(writes.map((call) => Object.keys(call.body)), [
    ["general_prompt"],
    ["post_call_analysis_data"],
  ]);
  assert.equal(agent.voice_id, "voice_keep");
  assert.equal(agent.webhook_url, "https://keep.example/webhook");
  assert.deepEqual(agent.webhook_events, ["call_started"]);
  assert.deepEqual(llm.general_tools, [{ type: "end_call", name: "end_call" }]);
  assert.equal(llm.start_speaker, "agent");

  calls.length = 0;
  const again = await setup.syncPromptAndAnalysis("key", "agent_1", "new prompt", {
    api,
    agentVersion: 3,
  });
  assert.deepEqual(again.changes, { llm: [], agent: [] });
  assert.equal(calls.some((call) => call.method === "PATCH"), false);
});

test("prompt migration fails closed when the attached LLM version does not match", async () => {
  const api = async (_key, method, path) => {
    if (method === "GET" && path === "/get-agent/agent_1?version=latest") {
      return {
        agent_id: "agent_1",
        version: 4,
        response_engine: { type: "retell-llm", llm_id: "llm_1", version: 7 },
        post_call_analysis_data: setup.POST_CALL_ANALYSIS,
      };
    }
    if (method === "GET" && path === "/get-retell-llm/llm_1?version=7") {
      return { llm_id: "llm_1", version: 8, general_prompt: "prompt" };
    }
    throw new Error(`${method} ${path}`);
  };

  await assert.rejects(
    setup.syncPromptAndAnalysis("key", "agent_1", "prompt", {
      api,
      dryRun: true,
      agentVersion: "latest",
    }),
    /LLM version mismatch/
  );
});
