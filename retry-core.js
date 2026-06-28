// callwright — retry-on-no-answer core. Pure functions: classify a Retell
// disconnection, parse a retry policy (DEFAULT = exactly 1 retry; never more
// without an explicit per-call request — anti-spam), round-trip the policy +
// attempt counter through the call's dynamic variables, and decide whether a
// finished call should be re-dialed.
//
// The policy travels IN the call's dynamic vars (retry_max/retry_on/
// retry_attempt/retry_delay), so the webhook can decide from the call_ended
// payload alone — no job lookup — and the incrementing attempt counter makes
// the retry chain self-terminating.

const MAX_RETRY_CAP = 5;        // absolute ceiling, even on explicit request
const MAX_DELAY_SECONDS = 600;  // 10 min (best-effort while the machine is warm)
const DEFAULT_MAX_RETRIES = 1;  // <-- the anti-spam default: one retry, no more
const DEFAULT_DELAY_SECONDS = 60;

// Retell disconnection_reason -> coarse category.
const REASON_CATEGORY = {
  dial_no_answer: "no_answer",
  no_answer: "no_answer",
  dial_busy: "busy",
  busy: "busy",
  dial_failed: "failed",
  failed: "failed",
  voicemail_reached: "voicemail",
  machine_detected: "voicemail",
  voicemail: "voicemail",
  user_hangup: "answered",
  agent_hangup: "answered",
  call_transfer: "answered",
  inactivity: "answered",
  max_duration_reached: "answered",
  scam_detected: "blocked",
  no_valid_payment: "blocked",
  concurrency_limit_reached: "blocked",
};

function classifyDisconnect(reason) {
  const r = String(reason || "").toLowerCase();
  if (REASON_CATEGORY[r]) return REASON_CATEGORY[r];
  if (r.startsWith("error")) return "error";
  return "other";
}

// Categories that retry can act on (no-answer / busy / transient failure).
const DEFAULT_ON = ["no_answer", "busy", "failed"];

function normalizeCategory(token) {
  const t = String(token || "").toLowerCase();
  return REASON_CATEGORY[t] || (DEFAULT_ON.includes(t) ? t : (t === "voicemail" ? "voicemail" : t));
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function parseRetryPolicy(overridesRetry) {
  const o = overridesRetry || {};
  const rawMax = (o.max_retries === undefined || o.max_retries === null) ? DEFAULT_MAX_RETRIES : Number(o.max_retries);
  const maxRetries = Number.isFinite(rawMax) ? clamp(Math.trunc(rawMax), 0, MAX_RETRY_CAP) : DEFAULT_MAX_RETRIES;
  const rawDelay = (o.delay_seconds === undefined || o.delay_seconds === null) ? DEFAULT_DELAY_SECONDS : Number(o.delay_seconds);
  const delaySeconds = Number.isFinite(rawDelay) ? clamp(Math.trunc(rawDelay), 0, MAX_DELAY_SECONDS) : DEFAULT_DELAY_SECONDS;
  const onList = Array.isArray(o.on) && o.on.length ? o.on.map(normalizeCategory) : DEFAULT_ON.slice();
  return { maxRetries, delaySeconds, on: new Set(onList) };
}

function policyToVars(policy, attempt = 0) {
  return {
    retry_max: String(policy.maxRetries),
    retry_on: [...policy.on].join(","),
    retry_delay: String(policy.delaySeconds),
    retry_attempt: String(attempt),
  };
}

function readPolicyVars(vars) {
  const v = vars || {};
  if (v.retry_max === undefined || v.retry_max === null || v.retry_max === "") return null; // no policy present
  const on = new Set(String(v.retry_on || "").split(",").map((s) => s.trim()).filter(Boolean).map(normalizeCategory));
  return {
    maxRetries: clamp(parseInt(v.retry_max, 10) || 0, 0, MAX_RETRY_CAP),
    delaySeconds: clamp(parseInt(v.retry_delay, 10) || 0, 0, MAX_DELAY_SECONDS),
    attempt: parseInt(v.retry_attempt, 10) || 0,
    on,
  };
}

// Decide whether a finished call should be retried. Pure: reads the call's
// disconnection_reason + retry_* dynamic vars. Returns the NEXT attempt number.
function decideRetry(call) {
  const reason = call && call.disconnection_reason;
  const category = classifyDisconnect(reason);
  const policy = readPolicyVars(call && call.retell_llm_dynamic_variables);
  if (!policy) return { retry: false, reason: "no_policy", category };
  if (policy.maxRetries <= 0) return { retry: false, reason: "max_retries_reached", category, maxRetries: policy.maxRetries };
  if (!policy.on.has(category)) return { retry: false, reason: "not_retryable", category };
  if (policy.attempt >= policy.maxRetries) return { retry: false, reason: "max_retries_reached", category, attempt: policy.attempt, maxRetries: policy.maxRetries };
  return {
    retry: true,
    attempt: policy.attempt + 1,
    maxRetries: policy.maxRetries,
    delaySeconds: policy.delaySeconds,
    category,
  };
}

// Vars for the re-dial: same vars, attempt bumped so the chain self-terminates.
function buildRetryVars(vars, attempt) {
  return { ...(vars || {}), retry_attempt: String(attempt) };
}

// A one-line human summary for the read-back.
function describePolicy(policy) {
  if (!policy || policy.maxRetries <= 0) return "off (no automatic retry)";
  const on = [...policy.on].join("/");
  return `up to ${policy.maxRetries} on ${on} (after ${policy.delaySeconds}s, best-effort)`;
}

module.exports = {
  MAX_RETRY_CAP, MAX_DELAY_SECONDS, DEFAULT_MAX_RETRIES, DEFAULT_DELAY_SECONDS, DEFAULT_ON,
  classifyDisconnect, parseRetryPolicy, policyToVars, readPolicyVars,
  decideRetry, buildRetryVars, describePolicy,
};
