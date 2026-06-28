// TDD suite for notify-core (per-call SMS "notify me when it's done").
const test = require("node:test");
const assert = require("node:assert");
const N = require("../notify-core.js");

const baseCall = (over = {}) => ({
  call_id: "call_1",
  to_number: "+15551230000",
  retell_llm_dynamic_variables: { business_name: "Sakura Sushi", objective: "table for 2 Friday 7pm", ...over.vars },
  call_analysis: { call_successful: true, call_summary: "Booked.", custom_analysis_data: { status: "booked", booked_date: "2026-07-01", booked_time: "7:00 PM", confirmation_ref: "ABC123" } },
  ...over.call,
});

// ---- buildCallSms (pure) ----
test("buildCallSms: booked includes business, status, date/time, conf", () => {
  const s = N.buildCallSms(baseCall());
  assert.ok(s.includes("Sakura Sushi"));
  assert.ok(/book/i.test(s));
  assert.ok(s.includes("2026-07-01") && s.includes("7:00 PM"));
  assert.ok(s.includes("ABC123"));
  assert.ok(s.length <= 320);
});

test("buildCallSms: voicemail / failed / callback variants", () => {
  const vm = N.buildCallSms(baseCall({ call: { call_analysis: { custom_analysis_data: { status: "voicemail" } } } }));
  assert.ok(/voicemail/i.test(vm));
  const failed = N.buildCallSms(baseCall({ call: { call_analysis: { call_successful: false, custom_analysis_data: {} } } }));
  assert.ok(/❌|not (completed|reached)|fail/i.test(failed));
  const cb = N.buildCallSms(baseCall({ call: { call_analysis: { custom_analysis_data: { status: "callback_needed" } } } }));
  assert.ok(/callback/i.test(cb));
});

test("buildCallSms: falls back to to_number when business missing", () => {
  const s = N.buildCallSms({ to_number: "+15557654321", call_analysis: { custom_analysis_data: { status: "booked" } }, retell_llm_dynamic_variables: {} });
  assert.ok(s.includes("+15557654321"));
});

// ---- shouldNotify (pure, reads round-tripped vars) ----
test("shouldNotify: reads notify_sms / notify_to vars", () => {
  assert.deepEqual(N.shouldNotify({ retell_llm_dynamic_variables: { notify_sms: "1", notify_to: "+15550101111" } }), { notify: true, to: "+15550101111" });
  assert.equal(N.shouldNotify({ retell_llm_dynamic_variables: { notify_sms: "0" } }).notify, false);
  assert.equal(N.shouldNotify({ retell_llm_dynamic_variables: {} }).notify, false);
  assert.equal(N.shouldNotify({}).notify, false);
});

// ---- fake api ----
function makeApi(opts = {}) {
  const calls = [];
  const api = async (method, p, body) => {
    calls.push({ method, path: p, body });
    if (p === "/create-retell-llm") return { llm_id: "llm_sms" };
    if (p === "/create-chat-agent") return { agent_id: "agent_sms" };
    if (p === "/create-sms-chat") { if (opts.failSend) throw new Error("not SMS-capable"); return { chat_id: "chat_1" }; }
    return {};
  };
  return { api, calls };
}

// ---- notifyCall (orchestrator) ----
test("notifyCall: not requested -> no send", async () => {
  const { api, calls } = makeApi();
  const r = await N.notifyCall(baseCall({ vars: { notify_sms: "0" } }), { config: {}, api });
  assert.equal(r.sent, false);
  assert.equal(r.reason, "not_requested");
  assert.equal(calls.length, 0);
});

test("notifyCall: requested but no number resolvable -> no_number", async () => {
  const { api } = makeApi();
  const call = baseCall({ vars: { notify_sms: "1" } }); // no notify_to
  const r = await N.notifyCall(call, { config: { retell: { from_number: "+15550109999" } }, api });
  assert.equal(r.sent, false);
  assert.equal(r.reason, "no_number");
});

test("notifyCall: self-call (to == notify target) is skipped", async () => {
  const { api } = makeApi();
  const call = baseCall({ call: { to_number: "+15550101111" }, vars: { notify_sms: "1", notify_to: "+15550101111" } });
  const r = await N.notifyCall(call, { config: { retell: { from_number: "+15550109999" } }, api });
  assert.equal(r.sent, false);
  assert.equal(r.reason, "self_call");
});

test("notifyCall: provisions the SMS agent when missing, then sends", async () => {
  const { api, calls } = makeApi();
  const config = { retell: { from_number: "+15550109999" } };
  const call = baseCall({ vars: { notify_sms: "1", notify_to: "+15550101111" } });
  const r = await N.notifyCall(call, { config, api });
  assert.equal(r.sent, true, JSON.stringify(r));
  assert.equal(r.to, "+15550101111");
  assert.ok(calls.some((c) => c.path === "/create-retell-llm"));
  assert.ok(calls.some((c) => c.path === "/create-chat-agent"));
  const send = calls.find((c) => c.path === "/create-sms-chat");
  assert.equal(send.body.to_number, "+15550101111");
  assert.equal(send.body.from_number, "+15550109999");
  assert.equal(send.body.override_agent_id, "agent_sms");
  assert.ok(send.body.retell_llm_dynamic_variables.summary.includes("Sakura Sushi"));
  // config updated with the provisioned agent so next time reuses it
  assert.equal(r.configChanged, true);
  assert.equal(config.notify.sms.chat_agent_id, "agent_sms");
});

test("notifyCall: reuses an existing provisioned agent (no re-create)", async () => {
  const { api, calls } = makeApi();
  const config = { retell: { from_number: "+15550109999" }, notify: { sms: { chat_agent_id: "agent_pre", chat_llm_id: "llm_pre" } } };
  const call = baseCall({ vars: { notify_sms: "1", notify_to: "+15550101111" } });
  const r = await N.notifyCall(call, { config, api });
  assert.equal(r.sent, true);
  assert.equal(calls.some((c) => c.path === "/create-chat-agent"), false);
  assert.equal(r.configChanged, false);
});

test("notifyCall: falls back to config.notify.sms.to then callback_number", async () => {
  const { api, calls } = makeApi();
  const config = { retell: { from_number: "+1" }, notify: { sms: { to: "+15710001111", chat_agent_id: "a", chat_llm_id: "l" } } };
  const r = await N.notifyCall(baseCall({ vars: { notify_sms: "1" } }), { config, api });
  assert.equal(r.sent, true);
  assert.equal(calls.find((c) => c.path === "/create-sms-chat").body.to_number, "+15710001111");
});

test("notifyCall: send failure surfaces reason", async () => {
  const { api } = makeApi({ failSend: true });
  const config = { retell: { from_number: "+1" }, notify: { sms: { chat_agent_id: "a", chat_llm_id: "l" } } };
  const r = await N.notifyCall(baseCall({ vars: { notify_sms: "1", notify_to: "+15550101111" } }), { config, api });
  assert.equal(r.sent, false);
  assert.ok(/SMS-capable|not SMS/i.test(r.error));
});

test("notifyCall: A2P 404 -> actionable needs_a2p_registration hint", async () => {
  const api = async (m, p) => {
    if (p === "/create-sms-chat") throw new Error('POST /create-sms-chat -> 404\n{"message":"Item not found in a2p-application with phoneNumber=+1"}');
    return {};
  };
  const config = { retell: { from_number: "+15550109999" }, notify: { sms: { chat_agent_id: "a", chat_llm_id: "l" } } };
  const r = await N.notifyCall(baseCall({ vars: { notify_sms: "1", notify_to: "+15550101111" } }), { config, api });
  assert.equal(r.sent, false);
  assert.equal(r.reason, "needs_a2p_registration");
  assert.ok(/A2P/i.test(r.hint));
});
