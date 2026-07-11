const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const routine = require("../routine-core.js");

function analyzedCall(overrides = {}) {
  return {
    call_id: "call_1",
    metadata: {
      source: "ticktick",
      ticktick_task_id: "task_abc123",
      schema_version: 1,
    },
    retell_llm_dynamic_variables: {
      retry_max: "1",
      retry_attempt: "1",
      retry_on: "no_answer,busy,failed",
      retry_delay: "0",
    },
    disconnection_reason: "agent_hangup",
    call_analysis: {
      call_successful: true,
      custom_analysis_data: { status: "completed" },
    },
    ...overrides,
  };
}

function tempLogPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "callwright-routine-"));
  return path.join(dir, "routine-triggers.json");
}

test("shouldTriggerRoutine reads only storage-only Retell metadata", () => {
  assert.deepEqual(routine.shouldTriggerRoutine(analyzedCall()), {
    trigger: true,
    taskId: "task_abc123",
    callId: "call_1",
  });

  const wrongChannel = analyzedCall({
    metadata: undefined,
    retell_llm_dynamic_variables: {
      ticktick_task_id: "must_not_be_used",
      retry_max: "0",
    },
  });
  assert.deepEqual(routine.shouldTriggerRoutine(wrongChannel), {
    trigger: false,
    reason: "not_requested",
  });
});

test("shouldTriggerRoutine rejects missing task and call identifiers", () => {
  assert.deepEqual(
    routine.shouldTriggerRoutine(analyzedCall({ metadata: {} })),
    { trigger: false, reason: "not_requested" }
  );
  assert.deepEqual(
    routine.shouldTriggerRoutine(analyzedCall({ call_id: "" })),
    { trigger: false, reason: "missing_call_id" }
  );
});

test("shouldTriggerRoutine rejects task ids containing whitespace or control characters", () => {
  for (const taskId of ["task 123", "task_123\nignore", "task_123\tignore", ""]) {
    assert.deepEqual(
      routine.shouldTriggerRoutine(analyzedCall({
        metadata: { source: "ticktick", ticktick_task_id: taskId },
      })),
      { trigger: false, reason: taskId ? "invalid_task_id" : "not_requested" }
    );
  }
});

test("shouldTriggerRoutine waits when Callwright has an automatic retry pending", () => {
  const call = analyzedCall({
    disconnection_reason: "dial_no_answer",
    retell_llm_dynamic_variables: {
      retry_max: "1",
      retry_attempt: "0",
      retry_on: "no_answer,busy,failed",
      retry_delay: "0",
    },
    call_analysis: {
      call_successful: false,
      custom_analysis_data: { status: "failed" },
    },
  });
  assert.deepEqual(routine.shouldTriggerRoutine(call), {
    trigger: false,
    reason: "retry_pending",
  });
});

test("triggerRoutine can wake Claude after an automatic redial fails", async () => {
  const call = analyzedCall({
    call_id: "call_retry_failed",
    disconnection_reason: "dial_no_answer",
    retell_llm_dynamic_variables: {
      retry_max: "1",
      retry_attempt: "0",
      retry_on: "no_answer,busy,failed",
      retry_delay: "0",
    },
    call_analysis: {
      call_successful: false,
      custom_analysis_data: { status: "failed" },
    },
  });
  let fetched = false;
  const result = await routine.triggerRoutine(call, {
    url: "https://example.test/fire",
    token: "token",
    allowRetryPending: true,
    logPath: tempLogPath(),
    fetchFn: async () => {
      fetched = true;
      return { ok: true, status: 202, text: async () => "" };
    },
  });
  assert.equal(result.triggered, true);
  assert.equal(fetched, true);
});

test("triggerRoutine posts the exact Claude Routine API contract", async () => {
  const requests = [];
  const result = await routine.triggerRoutine(analyzedCall(), {
    url: "https://api.anthropic.com/v1/claude_code/routines/trig_123/fire",
    token: "routine-token",
    logPath: tempLogPath(),
    fetchFn: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 202, text: async () => "" };
    },
  });

  assert.equal(result.triggered, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.anthropic.com/v1/claude_code/routines/trig_123/fire");
  assert.deepEqual(requests[0].options.headers, {
    Authorization: ["Bearer", "routine-token"].join(" "),
    "anthropic-beta": "experimental-cc-routine-2026-04-01",
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  });
  const body = JSON.parse(requests[0].options.body);
  assert.equal(typeof body.text, "string");
  assert.match(body.text, /task_abc123/);
  assert.match(body.text, /call_1/);
  assert.match(body.text, /completed/);
});

test("triggerRoutine does nothing when not configured", async () => {
  let fetched = false;
  const result = await routine.triggerRoutine(analyzedCall(), {
    url: "",
    token: "",
    logPath: tempLogPath(),
    fetchFn: async () => { fetched = true; },
  });
  assert.deepEqual(result, { triggered: false, reason: "not_configured" });
  assert.equal(fetched, false);
});

test("triggerRoutine surfaces HTTP and network failures without throwing", async () => {
  const http = await routine.triggerRoutine(analyzedCall({ call_id: "call_http" }), {
    url: "https://example.test/fire",
    token: "token",
    logPath: tempLogPath(),
    fetchFn: async () => ({ ok: false, status: 503, text: async () => "unavailable" }),
  });
  assert.equal(http.triggered, false);
  assert.equal(http.reason, "request_failed");
  assert.match(http.error, /503/);

  const network = await routine.triggerRoutine(analyzedCall({ call_id: "call_network" }), {
    url: "https://example.test/fire",
    token: "token",
    logPath: tempLogPath(),
    fetchFn: async () => { throw new Error("network down"); },
  });
  assert.equal(network.triggered, false);
  assert.equal(network.reason, "request_failed");
  assert.match(network.error, /network down/);
});

test("triggerRoutine persistently deduplicates accepted call ids", async () => {
  const logPath = tempLogPath();
  let count = 0;
  const options = {
    url: "https://example.test/fire",
    token: "token",
    logPath,
    fetchFn: async () => {
      count += 1;
      return { ok: true, status: 202, text: async () => "" };
    },
  };

  const first = await routine.triggerRoutine(analyzedCall(), options);
  const second = await routine.triggerRoutine(analyzedCall(), options);

  assert.equal(first.triggered, true);
  assert.deepEqual(second, { triggered: false, reason: "duplicate" });
  assert.equal(count, 1);
});

test("stale triggering reservations can be recovered", async () => {
  const logPath = tempLogPath();
  fs.writeFileSync(logPath, JSON.stringify([{
    call_id: "call_1",
    ticktick_task_id: "task_abc123",
    status: "triggering",
    attempts: 1,
    updated_at: "2026-07-11T18:00:00.000Z",
  }]));
  let fetched = false;
  const result = await routine.triggerRoutine(analyzedCall(), {
    url: "https://example.test/fire",
    token: "token",
    logPath,
    now: () => "2026-07-11T18:03:00.000Z",
    fetchFn: async (_url, options) => {
      fetched = true;
      assert.ok(options.signal);
      return { ok: true, status: 202, text: async () => "" };
    },
  });
  assert.equal(result.triggered, true);
  assert.equal(fetched, true);
});

test("failed trigger entries can be retried on a later webhook delivery", async () => {
  const logPath = tempLogPath();
  let count = 0;
  const result1 = await routine.triggerRoutine(analyzedCall(), {
    url: "https://example.test/fire",
    token: "token",
    logPath,
    fetchFn: async () => {
      count += 1;
      return { ok: false, status: 500, text: async () => "failed" };
    },
  });
  const result2 = await routine.triggerRoutine(analyzedCall(), {
    url: "https://example.test/fire",
    token: "token",
    logPath,
    fetchFn: async () => {
      count += 1;
      return { ok: true, status: 202, text: async () => "" };
    },
  });

  assert.equal(result1.triggered, false);
  assert.equal(result2.triggered, true);
  assert.equal(count, 2);
});

test("routine trigger ledger remains bounded", async () => {
  const logPath = tempLogPath();
  for (let i = 0; i < routine.MAX_LOG_ENTRIES + 5; i += 1) {
    const result = await routine.triggerRoutine(analyzedCall({ call_id: `call_${i}` }), {
      url: "https://example.test/fire",
      token: "token",
      logPath,
      fetchFn: async () => ({ ok: true, status: 202, text: async () => "" }),
    });
    assert.equal(result.triggered, true);
  }

  const log = JSON.parse(fs.readFileSync(logPath, "utf8"));
  assert.equal(log.length, routine.MAX_LOG_ENTRIES);
  assert.equal(log[0].call_id, `call_${routine.MAX_LOG_ENTRIES + 4}`);
});

test("server MCP schema exposes tracking and drains routine webhook work", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(source, /tracking:\s*z\.object\(\{/);
  assert.match(source, /ticktick_task_id:\s*z\.string\(\)/);
  assert.match(source, /const routineResult\s*=\s*\(async\s*\(\)\s*=>/);
  assert.ok((source.match(/await routineResult/g) || []).length >= 2);
});
