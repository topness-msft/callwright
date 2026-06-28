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
