// TDD suite for retry-core (retry-on-no-answer policy + decision).
const test = require("node:test");
const assert = require("node:assert");
const R = require("../retry-core.js");

// ---- classifyDisconnect ----
test("classifyDisconnect: maps Retell reasons to categories", () => {
  assert.equal(R.classifyDisconnect("dial_no_answer"), "no_answer");
  assert.equal(R.classifyDisconnect("dial_busy"), "busy");
  assert.equal(R.classifyDisconnect("dial_failed"), "failed");
  assert.equal(R.classifyDisconnect("voicemail_reached"), "voicemail");
  assert.equal(R.classifyDisconnect("machine_detected"), "voicemail");
  assert.equal(R.classifyDisconnect("user_hangup"), "answered");
  assert.equal(R.classifyDisconnect("agent_hangup"), "answered");
  assert.equal(R.classifyDisconnect("inactivity"), "answered");
  assert.equal(R.classifyDisconnect("max_duration_reached"), "answered");
  assert.equal(R.classifyDisconnect("scam_detected"), "blocked");
  assert.equal(R.classifyDisconnect("something_new"), "other");
});

// ---- parseRetryPolicy ----
test("parseRetryPolicy: defaults to exactly 1 retry on no-answer/busy/failed", () => {
  const p = R.parseRetryPolicy(undefined);
  assert.equal(p.maxRetries, 1);
  assert.deepEqual([...p.on].sort(), ["busy", "failed", "no_answer"]);
  assert.equal(p.delaySeconds, 60);
});

test("parseRetryPolicy: explicit max_retries honored but hard-capped", () => {
  assert.equal(R.parseRetryPolicy({ max_retries: 0 }).maxRetries, 0);
  assert.equal(R.parseRetryPolicy({ max_retries: 3 }).maxRetries, 3);
  assert.equal(R.parseRetryPolicy({ max_retries: 99 }).maxRetries, R.MAX_RETRY_CAP); // capped
  assert.equal(R.parseRetryPolicy({ max_retries: -5 }).maxRetries, 0); // floored
});

test("parseRetryPolicy: custom on-list + delay clamped", () => {
  const p = R.parseRetryPolicy({ on: ["no_answer"], delay_seconds: 5000 });
  assert.deepEqual([...p.on], ["no_answer"]);
  assert.equal(p.delaySeconds, R.MAX_DELAY_SECONDS); // clamped
  assert.equal(R.parseRetryPolicy({ delay_seconds: -10 }).delaySeconds, 0);
});

test("parseRetryPolicy: normalizes reason aliases", () => {
  const p = R.parseRetryPolicy({ on: ["dial_no_answer", "dial_busy", "voicemail_reached"] });
  assert.ok(p.on.has("no_answer") && p.on.has("busy") && p.on.has("voicemail"));
});

// ---- toVars / fromVars round-trip ----
test("policyToVars + readPolicyVars round-trip", () => {
  const p = R.parseRetryPolicy({ max_retries: 2, on: ["no_answer", "busy"], delay_seconds: 90 });
  const vars = R.policyToVars(p, 0);
  assert.equal(vars.retry_max, "2");
  assert.equal(vars.retry_attempt, "0");
  assert.equal(vars.retry_delay, "90");
  assert.ok(vars.retry_on.includes("no_answer"));
  const read = R.readPolicyVars(vars);
  assert.equal(read.maxRetries, 2);
  assert.equal(read.attempt, 0);
  assert.equal(read.delaySeconds, 90);
  assert.ok(read.on.has("busy"));
});

// ---- decideRetry ----
const callWith = (reason, vars) => ({
  call_id: "c1", to_number: "+15551230000", from_number: "+15550109999", agent_id: "agent_x",
  disconnection_reason: reason,
  retell_llm_dynamic_variables: vars,
});

test("decideRetry: no-answer with attempt 0/max 1 -> retry attempt 1", () => {
  const d = R.decideRetry(callWith("dial_no_answer", R.policyToVars(R.parseRetryPolicy(undefined), 0)));
  assert.equal(d.retry, true);
  assert.equal(d.attempt, 1);
  assert.equal(d.maxRetries, 1);
  assert.equal(d.category, "no_answer");
  assert.equal(d.delaySeconds, 60);
});

test("decideRetry: chain stops at the cap (attempt 1 of max 1)", () => {
  const d = R.decideRetry(callWith("dial_no_answer", R.policyToVars(R.parseRetryPolicy(undefined), 1)));
  assert.equal(d.retry, false);
  assert.equal(d.reason, "max_retries_reached");
});

test("decideRetry: answered call never retries", () => {
  const d = R.decideRetry(callWith("user_hangup", R.policyToVars(R.parseRetryPolicy(undefined), 0)));
  assert.equal(d.retry, false);
  assert.equal(d.reason, "not_retryable");
});

test("decideRetry: voicemail not retried by default", () => {
  const d = R.decideRetry(callWith("voicemail_reached", R.policyToVars(R.parseRetryPolicy(undefined), 0)));
  assert.equal(d.retry, false);
});

test("decideRetry: max_retries:0 disables retry entirely", () => {
  const d = R.decideRetry(callWith("dial_no_answer", R.policyToVars(R.parseRetryPolicy({ max_retries: 0 }), 0)));
  assert.equal(d.retry, false);
  assert.equal(d.reason, "max_retries_reached");
});

test("decideRetry: busy retries when in the on-list", () => {
  const d = R.decideRetry(callWith("dial_busy", R.policyToVars(R.parseRetryPolicy(undefined), 0)));
  assert.equal(d.retry, true);
  assert.equal(d.category, "busy");
});

test("decideRetry: no retry vars at all -> treated as default policy (1 retry on no-answer)", () => {
  // A call placed before retry existed: no retry_* vars. Be safe -> no retry
  // (we can't know the policy; avoid surprise re-dials).
  const d = R.decideRetry(callWith("dial_no_answer", { call_type: "haircut" }));
  assert.equal(d.retry, false);
  assert.equal(d.reason, "no_policy");
});

// ---- buildRetryVars (for the redial) ----
test("buildRetryVars: increments attempt, preserves other vars", () => {
  const base = { ...R.policyToVars(R.parseRetryPolicy(undefined), 0), call_type: "haircut", business_name: "X" };
  const next = R.buildRetryVars(base, 1);
  assert.equal(next.retry_attempt, "1");
  assert.equal(next.call_type, "haircut");
  assert.equal(next.business_name, "X");
});
