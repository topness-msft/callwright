// TDD suite for dispatch-core stored-fact resolution.
//
// Bug: stored `principal.facts` (e.g. service_address) were never resolved onto
// an outbound call — only name/callback_number were backfilled, and profiles
// merely warned. composeCall now resolves profile-recommended (and explicitly
// requested) stored facts into the "share-if-asked" set, without the caller
// re-supplying values and without leaking values to the model.

const test = require("node:test");
const assert = require("node:assert");
const dc = require("../dispatch-core.js");

// A minimal valid-enough job for composeCall (composeCall does not re-validate).
function baseJob(overrides = {}) {
  return {
    call_type: "appointment_confirmation",
    target: { business_name: "Ace Appliance Repair", phone_number: "+15555550199" },
    principal: { name: "Pat Doe", callback_number: "+15555550142" },
    request: {
      summary: "Confirm the stove repair appointment",
      preferred: { date: "2026-07-10", time: "10:00" },
    },
    ...overrides,
  };
}

// The appointment_confirmation profile recommends service_address (see
// scenario-profiles.json). These tests lean on that real profile on disk.

test("resolve: profile-recommended stored fact is attached without the caller re-supplying it", () => {
  const config = { principal: { name: "Pat Doe", facts: { service_address: "42 Elm St, Springfield" } } };
  const c = dc.composeCall(baseJob(), { config });

  assert.ok(c.piiKeys.includes("service_address"), "service_address should be in the share-if-asked set");
  assert.ok(c.vars.known_facts.includes("42 Elm St, Springfield"), "the stored value should reach the agent's known_facts");
  assert.ok(
    !c.missingRecommended.some((m) => m.key === "service_address"),
    "the 'recommends ... missing' warning must not fire once resolved"
  );
});

test("minimization: unrelated stored facts are NOT attached", () => {
  const config = {
    principal: {
      facts: { service_address: "42 Elm St, Springfield", member_id: "M-99999" },
    },
  };
  const c = dc.composeCall(baseJob(), { config });

  assert.ok(c.piiKeys.includes("service_address"), "recommended fact attached");
  assert.ok(!c.piiKeys.includes("member_id"), "non-recommended, non-requested fact must not be attached");
  assert.ok(!c.vars.known_facts.includes("M-99999"), "unrelated value must not reach the agent");
});

test("missing fact: warning still fires when the store has no value", () => {
  const config = { principal: { facts: {} } };
  const c = dc.composeCall(baseJob(), { config });

  assert.ok(!c.piiKeys.includes("service_address"), "nothing to attach");
  assert.ok(
    c.missingRecommended.some((m) => m.key === "service_address"),
    "the recommends-missing warning must still fire"
  );
});

test("explicit override: caller-supplied fact wins over the store (no double-attach)", () => {
  const config = { principal: { facts: { service_address: "STORE VALUE" } } };
  const job = baseJob({
    principal: { name: "Pat Doe", callback_number: "+15555550142", facts: { service_address: "CALLER VALUE" } },
  });
  const c = dc.composeCall(job, { config });

  assert.ok(c.vars.known_facts.includes("CALLER VALUE"), "caller value wins");
  assert.ok(!c.vars.known_facts.includes("STORE VALUE"), "store value must not override the caller");
  assert.equal(
    c.piiKeys.filter((k) => k === "service_address").length,
    1,
    "service_address must appear exactly once"
  );
});

test("value never leaks: read-back shows the key/type only, never the raw value", () => {
  const config = { principal: { name: "Pat Doe", facts: { service_address: "42 Elm St, Springfield" } } };
  const job = baseJob();
  const c = dc.composeCall(job, { config });
  const readback = dc.buildReadback(job, c).join("\n");

  assert.ok(readback.includes("service_address"), "the read-back lists the fact key");
  assert.ok(!readback.includes("42 Elm St, Springfield"), "the read-back must not echo the raw value");
});

test("escape hatch: principal.facts_from_store resolves a non-recommended stored key", () => {
  const config = { principal: { facts: { member_id: "M-99999" } } };
  const job = baseJob({
    principal: { name: "Pat Doe", callback_number: "+15555550142", facts_from_store: ["member_id"] },
  });
  const c = dc.composeCall(job, { config });

  assert.ok(c.piiKeys.includes("member_id"), "explicitly requested stored key is attached");
  assert.ok(c.vars.known_facts.includes("M-99999"), "its value reaches the agent");
});

test("empty stored value is treated as absent (does not resolve, still warns)", () => {
  const config = { principal: { facts: { service_address: "" } } };
  const c = dc.composeCall(baseJob(), { config });

  assert.ok(!c.piiKeys.includes("service_address"), "an empty stored value must not be attached");
  assert.ok(
    c.missingRecommended.some((m) => m.key === "service_address"),
    "an empty stored value still counts as missing"
  );
});
