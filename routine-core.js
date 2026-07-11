// callwright — Claude Routine trigger core.
//
// A TickTick task ID can be attached to a Retell call as storage-only metadata.
// When Retell finishes analyzing the final call in a retry chain, this module
// wakes a Claude cloud Routine so it can update that exact task immediately.

const fs = require("fs");
const path = require("path");
const outcome = require("./outcome-core");
const retry = require("./retry-core");
const paths = require("./paths");

const MAX_LOG_ENTRIES = 200;
const STALE_TRIGGER_MS = 2 * 60 * 1000;
const BETA_HEADER = "experimental-cc-routine-2026-04-01";
const ANTHROPIC_VERSION = "2023-06-01";
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function shouldTriggerRoutine(call, { allowRetryPending = false } = {}) {
  const metadata = (call && call.metadata) || {};
  const taskId = String(metadata.ticktick_task_id || "").trim();
  if (!taskId) return { trigger: false, reason: "not_requested" };
  if (!TASK_ID_PATTERN.test(taskId)) return { trigger: false, reason: "invalid_task_id" };

  const callId = String((call && call.call_id) || "").trim();
  if (!callId) return { trigger: false, reason: "missing_call_id" };

  if (!allowRetryPending && retry.decideRetry(call).retry) {
    return { trigger: false, reason: "retry_pending" };
  }

  return { trigger: true, taskId, callId };
}

function buildTriggerText(call, taskId) {
  const resolved = outcome.resolveOutcome(call);
  return [
    "A Callwright phone call has completed analysis.",
    `TickTick task ID: ${taskId}`,
    `Callwright call ID: ${call.call_id}`,
    `Canonical outcome: ${resolved.status}`,
    "Use TickTick MCP to fetch this exact task, use Callwright get_call_outcome",
    "for the full result, then apply the configured task completion workflow.",
  ].join("\n");
}

function loadLog(logPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(logPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLog(logPath, entries) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, JSON.stringify(entries.slice(0, MAX_LOG_ENTRIES), null, 2) + "\n");
}

function reserveTrigger(logPath, callId, taskId, now) {
  const log = loadLog(logPath);
  const existingIndex = log.findIndex((entry) => entry.call_id === callId);
  const existing = existingIndex >= 0 ? log[existingIndex] : null;
  const existingTime = existing && Date.parse(existing.updated_at);
  const nowTime = Date.parse(now);
  const staleTrigger = existing
    && existing.status === "triggering"
    && Number.isFinite(existingTime)
    && Number.isFinite(nowTime)
    && nowTime - existingTime >= STALE_TRIGGER_MS;
  if (existing && existing.status !== "failed" && !staleTrigger) {
    return { reserved: false, reason: "duplicate" };
  }

  const entry = {
    call_id: callId,
    ticktick_task_id: taskId,
    status: "triggering",
    attempts: (existing && existing.attempts ? existing.attempts : 0) + 1,
    updated_at: now,
  };
  if (existingIndex >= 0) log.splice(existingIndex, 1);
  log.unshift(entry);
  saveLog(logPath, log);
  return { reserved: true };
}

function updateTrigger(logPath, callId, patch) {
  const log = loadLog(logPath);
  const index = log.findIndex((entry) => entry.call_id === callId);
  if (index < 0) return;
  log[index] = { ...log[index], ...patch };
  saveLog(logPath, log);
}

async function triggerRoutine(call, {
  url = process.env.CLAUDE_ROUTINE_URL || "",
  token = process.env.CLAUDE_ROUTINE_TOKEN || "",
  fetchFn = global.fetch,
  logPath = paths.ROUTINE_TRIGGERS_PATH,
  now = () => new Date().toISOString(),
  allowRetryPending = false,
  timeoutMs = 8000,
} = {}) {
  const decision = shouldTriggerRoutine(call, { allowRetryPending });
  if (!decision.trigger) return { triggered: false, reason: decision.reason };
  if (!url || !token) return { triggered: false, reason: "not_configured" };

  try {
    const reservation = reserveTrigger(logPath, decision.callId, decision.taskId, now());
    if (!reservation.reserved) return { triggered: false, reason: reservation.reason };
  } catch (error) {
    return { triggered: false, reason: "state_failed", error: error.message || String(error) };
  }

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: ["Bearer", token].join(" "),
        "anthropic-beta": BETA_HEADER,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ text: buildTriggerText(call, decision.taskId) }),
    });
    const responseText = await response.text();
    if (!response.ok) {
      const error = `Claude Routine trigger ${response.status}${responseText ? `: ${responseText}` : ""}`;
      updateTrigger(logPath, decision.callId, {
        status: "failed",
        error,
        updated_at: now(),
      });
      return { triggered: false, reason: "request_failed", error };
    }

    updateTrigger(logPath, decision.callId, {
      status: "triggered",
      http_status: response.status,
      error: undefined,
      updated_at: now(),
    });
    return {
      triggered: true,
      call_id: decision.callId,
      ticktick_task_id: decision.taskId,
    };
  } catch (error) {
    const message = error.message || String(error);
    try {
      updateTrigger(logPath, decision.callId, {
        status: "failed",
        error: message,
        updated_at: now(),
      });
    } catch {
      // Preserve the original request failure.
    }
    return { triggered: false, reason: "request_failed", error: message };
  }
}

module.exports = {
  MAX_LOG_ENTRIES,
  STALE_TRIGGER_MS,
  BETA_HEADER,
  ANTHROPIC_VERSION,
  TASK_ID_PATTERN,
  shouldTriggerRoutine,
  buildTriggerText,
  triggerRoutine,
};
