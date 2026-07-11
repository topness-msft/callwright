// callwright — notification core. Per-call, opt-in SMS ("notify me when it's
// done") via Retell's outbound SMS (create-sms-chat). The DEFAULT remains
// pull-on-demand (get_call_outcome); SMS only fires when a call explicitly
// requested it (notify_sms round-tripped in the dynamic vars).
//
// Retell SMS requires a CHAT-mode agent; we provision a tiny "summary notifier"
// chat agent once and cache its id in config.notify.sms. The from_number must be
// a Retell number with SMS capability (KYC-gated).

const setup = require("./setup-core");
const outcome = require("./outcome-core");

const SMS_AGENT_PROMPT =
  "You are an SMS notifier for a personal assistant. Your ONLY job is to send a single " +
  "text message containing exactly the notification provided in the variable {{summary}}. " +
  "Send {{summary}} verbatim — no greeting, no sign-off, no extra words, and never ask a " +
  "question. After sending that one message you are done; if the recipient replies, do not " +
  "continue the conversation beyond a brief 'Thanks, noted.'";

const STATUS_EMOJI = { booked: "✅", failed: "❌", voicemail: "📭", callback_needed: "↩️", escalated: "⚠️", completed: "✅" };

// Build a concise one-line SMS summary of a finished call. Pure.
function buildCallSms(call) {
  const v = (call && call.retell_llm_dynamic_variables) || {};
  const a = (call && call.call_analysis) || {};
  const c = a.custom_analysis_data || {};
  const business = v.business_name || (call && call.to_number) || "the business";
  const objective = v.objective || v.objective_detail || "";
  const status = outcome.resolveOutcome(call).status;
  const emoji = STATUS_EMOJI[status] || "📞";

  const phrase = {
    booked: "booked", completed: "done", voicemail: "left a voicemail",
    callback_needed: "callback needed", escalated: "escalated", failed: "not completed",
    unknown: "outcome unknown",
  }[status] || status;

  const details = [];
  const when = `${c.booked_date || ""} ${c.booked_time || ""}`.trim();
  if (when) details.push(when);
  if (c.confirmation_ref) details.push(`conf ${c.confirmation_ref}`);

  let msg = `${emoji} ${business}${objective ? ` (${objective})` : ""}: ${phrase}`;
  if (details.length) msg += ` — ${details.join(", ")}`;
  msg += ".";
  return msg.slice(0, 320);
}

// Read the per-call notify intent off the round-tripped dynamic vars. Pure.
function shouldNotify(call) {
  const v = (call && call.retell_llm_dynamic_variables) || {};
  if (String(v.notify_sms || "") !== "1") return { notify: false };
  return { notify: true, to: v.notify_to || "" };
}

const defaultApi = (key) => (m, p, b) => setup.apiCall(key, m, p, b);

// Provision (or reuse) the SMS summary chat agent. Mutates `smsCfg` with the ids
// and returns whether it created a new one.
async function ensureSmsAgent(api, smsCfg = {}) {
  if (smsCfg.chat_agent_id) return { chat_agent_id: smsCfg.chat_agent_id, chat_llm_id: smsCfg.chat_llm_id, created: false };
  const llm = await api("POST", "/create-retell-llm", { general_prompt: SMS_AGENT_PROMPT });
  const agent = await api("POST", "/create-chat-agent", {
    response_engine: { type: "retell-llm", llm_id: llm.llm_id },
    agent_name: "callwright_sms_notifier",
  });
  smsCfg.chat_agent_id = agent.agent_id;
  smsCfg.chat_llm_id = llm.llm_id;
  return { chat_agent_id: agent.agent_id, chat_llm_id: llm.llm_id, created: true };
}

// Orchestrate a per-call SMS notification. Mutates `config` if it provisions the
// agent (caller persists when configChanged). Retell calls are injectable.
async function notifyCall(call, { config, api, key, to: forceTo, force = false } = {}) {
  api = api || defaultApi(key);
  const want = force ? { notify: true, to: forceTo } : shouldNotify(call);
  if (!want.notify) return { sent: false, reason: "not_requested" };

  const smsCfg = (config.notify && config.notify.sms) || {};
  const to = want.to || forceTo || smsCfg.to || (config.principal && config.principal.callback_number) || "";
  if (!to) return { sent: false, reason: "no_number" };
  if (!force && call && call.to_number && call.to_number === to) return { sent: false, reason: "self_call" };

  const fromNumber = smsCfg.from_number || (config.retell && config.retell.from_number);
  if (!fromNumber) return { sent: false, reason: "no_from_number" };

  let configChanged = false;
  try {
    config.notify = config.notify || {};
    config.notify.sms = config.notify.sms || {};
    const ens = await ensureSmsAgent(api, config.notify.sms);
    if (ens.created) configChanged = true;

    const summary = buildCallSms(call);
    const resp = await api("POST", "/create-sms-chat", {
      from_number: fromNumber,
      to_number: to,
      override_agent_id: config.notify.sms.chat_agent_id,
      retell_llm_dynamic_variables: { summary },
      metadata: { parent_call_id: call && call.call_id, kind: "call_notification" },
    });
    return { sent: true, to, from: fromNumber, chat_id: resp.chat_id || resp.chat_session_id || null, summary, configChanged };
  } catch (e) {
    const msg = e.message || String(e);
    if (/a2p/i.test(msg)) {
      return { sent: false, reason: "needs_a2p_registration", error: msg, configChanged,
        hint: `The from-number ${fromNumber} is not registered for A2P 10DLC SMS. Complete A2P brand+campaign registration for this number in the Retell dashboard (or use configure_notifications from_number with an already SMS-registered number). This is a US carrier requirement, separate from voice; no code change is needed once registered.` };
    }
    return { sent: false, reason: "send_failed", error: msg, configChanged };
  }
}

module.exports = {
  SMS_AGENT_PROMPT, buildCallSms, shouldNotify, ensureSmsAgent, notifyCall,
};
