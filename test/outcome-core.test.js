const test = require("node:test");
const assert = require("node:assert");
const { resolveOutcome } = require("../outcome-core.js");

test("custom failed is authoritative over Retell successful", () => {
  const outcome = resolveOutcome({
    call_analysis: {
      call_successful: true,
      custom_analysis_data: { status: "failed" },
    },
  });

  assert.deepEqual(outcome, {
    status: "failed",
    successful: false,
    source: "custom_status",
    conflict: "retell_success_custom_failure",
    raw: {
      custom_status: "failed",
      call_successful: true,
    },
  });
});

test("completed represents a successful informational call", () => {
  const outcome = resolveOutcome({
    call_analysis: {
      call_successful: true,
      custom_analysis_data: { status: "completed" },
    },
  });

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.successful, true);
  assert.equal(outcome.source, "custom_status");
  assert.equal(outcome.conflict, null);
});

test("missing custom status falls back to Retell success", () => {
  assert.equal(resolveOutcome({ call_analysis: { call_successful: true } }).status, "completed");
  assert.equal(resolveOutcome({ call_analysis: { call_successful: false } }).status, "failed");
  assert.equal(resolveOutcome({ call_analysis: {} }).status, "unknown");
});

test("unknown custom status remains unknown instead of trusting Retell", () => {
  const outcome = resolveOutcome({
    call_analysis: {
      call_successful: true,
      custom_analysis_data: { status: "answered" },
    },
  });

  assert.equal(outcome.status, "unknown");
  assert.equal(outcome.successful, null);
  assert.equal(outcome.source, "unknown_custom_status");
  assert.equal(outcome.raw.custom_status, "answered");
});

test("only definite success and failure statuses produce conflicts", () => {
  assert.equal(resolveOutcome({
    call_analysis: {
      call_successful: false,
      custom_analysis_data: { status: "booked" },
    },
  }).conflict, "retell_failure_custom_success");

  assert.equal(resolveOutcome({
    call_analysis: {
      call_successful: true,
      custom_analysis_data: { status: "callback_needed" },
    },
  }).conflict, null);
});
