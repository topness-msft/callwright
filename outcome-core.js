// Canonical interpretation of Retell post-call outcome signals.
// Custom status is authoritative; Retell's built-in boolean is a fallback and
// corroborating signal because the two analyses can disagree.

const CUSTOM_STATUSES = new Set([
  "booked",
  "completed",
  "failed",
  "voicemail",
  "callback_needed",
  "escalated",
]);

const SUCCESS_STATUSES = new Set(["booked", "completed"]);

function resolveOutcome(call) {
  const analysis = (call && call.call_analysis) || {};
  const custom = analysis.custom_analysis_data || {};
  const rawCustomStatus = typeof custom.status === "string" && custom.status.trim()
    ? custom.status.trim()
    : null;
  const retellSuccessful = typeof analysis.call_successful === "boolean"
    ? analysis.call_successful
    : null;

  let status;
  let source;
  if (rawCustomStatus) {
    status = CUSTOM_STATUSES.has(rawCustomStatus) ? rawCustomStatus : "unknown";
    source = CUSTOM_STATUSES.has(rawCustomStatus) ? "custom_status" : "unknown_custom_status";
  } else if (retellSuccessful === true) {
    status = "completed";
    source = "retell_fallback";
  } else if (retellSuccessful === false) {
    status = "failed";
    source = "retell_fallback";
  } else {
    status = "unknown";
    source = "unknown";
  }

  const successful = SUCCESS_STATUSES.has(status)
    ? true
    : status === "failed"
      ? false
      : null;

  let conflict = null;
  if (status === "failed" && retellSuccessful === true) {
    conflict = "retell_success_custom_failure";
  } else if (SUCCESS_STATUSES.has(status) && retellSuccessful === false) {
    conflict = "retell_failure_custom_success";
  }

  return {
    status,
    successful,
    source,
    conflict,
    raw: {
      custom_status: rawCustomStatus,
      call_successful: retellSuccessful,
    },
  };
}

module.exports = { CUSTOM_STATUSES, SUCCESS_STATUSES, resolveOutcome };
