// TDD suite for learn-core (profile enrichment + auto-creation staging).
const os = require("os");
const fs = require("fs");
const path = require("path");

const VOL = fs.mkdtempSync(path.join(os.tmpdir(), "cw-learn-"));
process.env.CALLWRIGHT_DATA_DIR = VOL;

const test = require("node:test");
const assert = require("node:assert");

const L = require("../learn-core.js");

test.after(() => fs.rmSync(VOL, { recursive: true, force: true }));

// ---- generalizeCallType (#1 instance-shape) ----
test("generalizeCallType: strips instance-shaped parts", () => {
  assert.equal(L.generalizeCallType("hotel_transport_to_haneda").general, "hotel_transport");
  assert.equal(L.generalizeCallType("haircut_with_jenny").general, "haircut");
  assert.equal(L.generalizeCallType("friday_dinner_for_2").general, "dinner");
  assert.equal(L.generalizeCallType("dinner_for_4").general, "dinner");
});

test("generalizeCallType: leaves general types unchanged", () => {
  assert.equal(L.generalizeCallType("hotel_transport_inquiry").general, "hotel_transport_inquiry");
  assert.equal(L.generalizeCallType("restaurant_reservation").general, "restaurant_reservation");
  assert.equal(L.generalizeCallType("hotel_transport_inquiry").changed, false);
});

// ---- looksInstanceValued (#3 value-rejection) ----
test("looksInstanceValued: flags value-baked fields", () => {
  assert.equal(L.looksInstanceValued("destination_haneda", "Is the destination Haneda?"), true);
  assert.equal(L.looksInstanceValued("party_of_4", "Party of 4"), true);
  assert.equal(L.looksInstanceValued("date_2026_07_01", ""), true);
});

test("looksInstanceValued: passes generalized fields", () => {
  assert.equal(L.looksInstanceValued("destination", "Drop-off destination"), false);
  assert.equal(L.looksInstanceValued("service_type", "Type of service requested"), false);
  assert.equal(L.looksInstanceValued("party_size", "Number of people"), false);
});

// ---- mapQuestionToField ----
test("mapQuestionToField: maps known questions, null otherwise", () => {
  assert.equal(L.mapQuestionToField("What type of service would you like?").key, "service_type");
  assert.equal(L.mapQuestionToField("Do you have a preferred stylist?").key, "stylist");
  assert.equal(L.mapQuestionToField("What's the weather like?"), null);
});

// ---- detectGaps ----
test("detectGaps: finds defer turns + structured unanswered", () => {
  const call = {
    transcript: "Agent: Hello\nUser: What's your destination?\nAgent: I'm not sure, I'll check with the person I'm assisting.\nUser: ok",
    call_analysis: { custom_analysis_data: { unanswered_questions: "Pickup time?" } },
  };
  const gaps = L.detectGaps(call);
  assert.ok(gaps.some((g) => /destination/i.test(g.question)));
  assert.ok(gaps.some((g) => /pickup time/i.test(g.question)));
});

test("detectGaps: clean call yields none", () => {
  const call = { transcript: "Agent: Hi\nUser: We open at 9.\nAgent: Great, thank you.", call_analysis: {} };
  assert.equal(L.detectGaps(call).length, 0);
});

// ---- matchProfile ----
test("matchProfile: fuzzy name/alias match", () => {
  const profiles = { haircut: { aliases: ["salon", "barber"] }, restaurant_reservation: { aliases: [] } };
  assert.equal(L.matchProfile(profiles, "haircut"), "haircut");
  assert.equal(L.matchProfile(profiles, "barber"), "haircut");
  assert.equal(L.matchProfile(profiles, "totally_new_thing"), null);
});

// ---- enrichProfile (value-rejection guard applied) ----
test("enrichProfile: adds mapped field, records unmapped, rejects value-baked", () => {
  const prof = { recommended_details: {}, aliases: [] };
  const gaps = [
    { question: "What type of service?" },           // -> service_type
    { question: "What's the weather?" },              // unmapped -> recorded
  ];
  const r = L.enrichProfile(prof, gaps, "call_1");
  assert.ok(prof.recommended_details.service_type);
  assert.ok(r.added.includes("service_type"));
  assert.ok(prof.learned.length >= 1);
});

test("enrichProfile: does not duplicate an existing field", () => {
  const prof = { recommended_details: { service_type: "x" }, aliases: [], learned: [] };
  const r = L.enrichProfile(prof, [{ question: "What kind of service?" }], "call_2");
  assert.equal(r.added.length, 0);
});

test("enrichProfile: minCount>=2 records first, promotes on second occurrence", () => {
  const prof = { recommended_details: {}, learned: [] };
  const r1 = L.enrichProfile(prof, [{ question: "Do you have a preferred stylist?" }], "call_a", { minCount: 2 });
  assert.equal(r1.added.length, 0, "not promoted on first sight");
  assert.equal(prof.recommended_details.stylist, undefined);
  const r2 = L.enrichProfile(prof, [{ question: "Which stylist would you like?" }], "call_b", { minCount: 2 });
  assert.ok(r2.added.includes("stylist"), "promoted on second occurrence");
  assert.equal(prof.recommended_details.stylist, "Preferred stylist/barber name");
});

test("enrichProfile: idempotent on the same call_id (no double-count)", () => {
  const prof = { recommended_details: {}, learned: [] };
  L.enrichProfile(prof, [{ question: "Do you have a preferred stylist?" }], "call_x", { minCount: 2 });
  const again = L.enrichProfile(prof, [{ question: "Do you have a preferred stylist?" }], "call_x", { minCount: 2 });
  assert.equal(again.skipped, true);
  const stylistEntries = prof.learned.filter((e) => e.mapped_field === "stylist").length;
  assert.equal(stylistEntries, 1, "the same call is not recorded twice");
});

// ---- applyLearning (shared orchestrator) ----
test("applyLearning: enriches a matched profile", () => {
  const profiles = { haircut: { aliases: ["barber"], recommended_details: {}, learned: [] } };
  const candidates = {};
  const call = {
    call_id: "c1",
    transcript: "User: What type of service?\nAgent: I'm not sure, I'll check with the person I'm assisting.",
    retell_llm_dynamic_variables: { call_type: "haircut" },
  };
  const r = L.applyLearning(call, { profiles, candidates, minCount: 1 });
  assert.equal(r.mode, "enriched");
  assert.equal(r.profile, "haircut");
  assert.ok(profiles.haircut.recommended_details.service_type);
});

test("applyLearning: stages an unmatched scenario candidate", () => {
  const profiles = {};
  const candidates = {};
  const call = {
    call_id: "c1",
    transcript: "User: What's your destination?\nAgent: I'll check with the person I'm assisting.",
    retell_llm_dynamic_variables: { call_type: "limo_to_haneda" },
  };
  const r = L.applyLearning(call, { profiles, candidates, minCount: 2, N: 2 });
  assert.equal(r.mode, "staged");
  assert.equal(r.scenario, "limo");
  assert.equal(candidates.limo.count, 1);
});

test("applyLearning: skips when no call_type or no gaps", () => {
  const r1 = L.applyLearning({ call_id: "c", transcript: "User: hi\nAgent: I'm not sure, I'll check with them." }, { profiles: {}, candidates: {} });
  assert.equal(r1.mode, "skip"); // no call_type
  const r2 = L.applyLearning({ call_id: "c", transcript: "Agent: Hi\nUser: We open at 9.", retell_llm_dynamic_variables: { call_type: "haircut" } }, { profiles: { haircut: {} }, candidates: {} });
  assert.equal(r2.mode, "skip"); // no gaps
});

// ---- stageCandidate (#4 N>=2 promotion) ----
test("stageCandidate: increments count, dedups, promotes at N", () => {
  let store = {};
  let r = L.stageCandidate(store, "hotel_transport", { callId: "c1", variant: "hire_car", gaps: [{ question: "What's your destination?" }] }, 2);
  assert.equal(r.candidate.count, 1);
  assert.equal(r.ready, false);
  r = L.stageCandidate(store, "hotel_transport", { callId: "c2", variant: "airport_transfer", gaps: [{ question: "What's your destination?" }] }, 2);
  assert.equal(r.candidate.count, 2);
  assert.equal(r.ready, true);
  assert.deepEqual(r.candidate.examples, ["c1", "c2"]);
  assert.ok(r.candidate.variants.includes("hire_car") && r.candidate.variants.includes("airport_transfer"));
});

test("stageCandidate: same call_id does not double-count", () => {
  let store = {};
  L.stageCandidate(store, "x", { callId: "c1", variant: "x", gaps: [] }, 2);
  const r = L.stageCandidate(store, "x", { callId: "c1", variant: "x", gaps: [] }, 2);
  assert.equal(r.candidate.count, 1);
});

// ---- buildProposal ----
test("buildProposal: generalized fields (count>=N) + variant aliases", () => {
  let store = {};
  L.stageCandidate(store, "hotel_transport", { callId: "c1", variant: "hire_car", gaps: [{ question: "What's your destination?" }] }, 2);
  L.stageCandidate(store, "hotel_transport", { callId: "c2", variant: "airport_transfer", gaps: [{ question: "Where to?" }] }, 2);
  const p = L.buildProposal("hotel_transport", store["hotel_transport"], 2);
  assert.equal(p.name, "hotel_transport");
  assert.ok(p.aliases.includes("hire_car"));
  // destination asked twice -> should be a recommended field
  assert.ok(Object.keys(p.recommended_details).includes("destination"));
});

// ---- validateNewProfile (#1 + collision) ----
test("validateNewProfile: rejects instance-shaped names + collisions", () => {
  const profiles = { haircut: { aliases: ["barber"] } };
  assert.equal(L.validateNewProfile("hotel_transport_to_haneda", profiles).ok, false); // instance-shaped
  assert.ok(L.validateNewProfile("barber", profiles).collision);                       // alias collision
  assert.ok(L.validateNewProfile("haircut", profiles).collision);                      // name collision
  assert.equal(L.validateNewProfile("hotel_transport", profiles).ok, true);            // good
});

test("validateNewProfile: rejects value-baked recommended_details", () => {
  const r = L.validateNewProfile("hotel_transport", {}, { destination_haneda: "Is it Haneda?" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.join(" ").includes("destination_haneda"));
});
