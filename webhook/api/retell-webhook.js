// Retell -> Resend email notifier (serverless, scale-to-zero).
// Deploy on Vercel as /api/retell-webhook. Runs ONLY when Retell posts a
// completed call, then emails a status summary. No always-on server, no DB.
//
// Env (Vercel project settings):
//   RETELL_API_KEY   - to verify the webhook signature
//   RESEND_API_KEY   - your Resend key
//   EMAIL_FROM       - a verified Resend sender, e.g. "calls@yourdomain.com"
//   EMAIL_TO         - where to send status emails (your inbox)

const { Resend } = require("resend");

// Build the email subject + html from a Retell call object. Exported for testing.
function buildEmail(call) {
  const v = call.retell_llm_dynamic_variables || {};
  const a = call.call_analysis || {};
  const c = a.custom_analysis_data || {};

  const business = v.business_name || call.to_number || "(unknown)";
  const objective = v.objective || v.objective_detail || "call";
  const status = c.status || (a.call_successful ? "completed" : "failed");
  const dur = call.duration_ms ? Math.round(call.duration_ms / 1000) + "s" : "n/a";

  const emoji = { booked: "✅", failed: "❌", voicemail: "📭",
    callback_needed: "↩️", escalated: "⚠️" }[status] || "📞";

  const subject = `${emoji} [${status}] ${business} — ${objective}`;

  const callIdLink = call.call_id
    ? `<a href="https://dashboard.retellai.com/call-history?history=${call.call_id}" style="color:#0066cc;text-decoration:none">${call.call_id}</a>`
    : null;

  const rows = [
    ["Status", status],
    ["Business", business],
    ["Objective", objective],
    ["Booked date", c.booked_date],
    ["Booked time", c.booked_time],
    ["Confirmation", c.confirmation_ref],
    ["Accommodations OK", c.accommodations_ok],
    ["Unmet items", c.unmet_items],
    ["Unanswered questions", c.unanswered_questions],
    ["Duration", dur],
    ["Disconnect", call.disconnection_reason],
    ["Call ID", callIdLink],
  ].filter(([, val]) => val !== undefined && val !== null && val !== "");

  const tableRows = rows
    .map(([k, val]) => `<tr><td style="padding:4px 10px;color:#666">${k}</td><td style="padding:4px 10px"><b>${val}</b></td></tr>`)
    .join("");

  const summary = a.call_summary ? `<p style="margin:12px 0">${a.call_summary}</p>` : "";
  const transcript = call.transcript
    ? `<details><summary style="cursor:pointer;color:#666">Transcript</summary><pre style="white-space:pre-wrap;font-size:13px;background:#f6f6f6;padding:10px;border-radius:6px">${escapeHtml(call.transcript)}</pre></details>`
    : "";

  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
    <h2 style="margin:0 0 6px">${emoji} ${objective}</h2>
    <div style="color:#666;margin-bottom:10px">${business}</div>
    ${summary}
    <table style="border-collapse:collapse;font-size:14px">${tableRows}</table>
    <div style="margin-top:14px">${transcript}</div>
  </div>`;

  return { subject, html };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// Vercel serverless handler.
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end("POST only");

  // Verify the webhook is from Retell (signature over the JSON body).
  try {
    const Retell = require("retell-sdk").Retell || require("retell-sdk").default;
    const sig = req.headers["x-retell-signature"];
    const ok = Retell.verify(JSON.stringify(req.body), process.env.RETELL_API_KEY, sig);
    if (!ok) return res.status(401).end("invalid signature");
  } catch (e) {
    // If verification lib/shape changes, fail closed unless explicitly bypassed.
    if (process.env.WEBHOOK_SKIP_VERIFY !== "1") {
      return res.status(401).end("signature verification failed: " + e.message);
    }
  }

  const { event, call } = req.body || {};
  // Only notify on the fully-analyzed event (has call_analysis).
  if (event !== "call_analyzed") return res.status(200).json({ skipped: event });

  try {
    const { subject, html } = buildEmail(call);
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: process.env.EMAIL_TO,
      subject,
      html,
    });
    return res.status(200).json({ emailed: true });
  } catch (e) {
    // Return 200 so Retell doesn't retry forever on a mail error; log for visibility.
    console.error("email send failed:", e.message);
    return res.status(200).json({ emailed: false, error: e.message });
  }
};

module.exports.buildEmail = buildEmail;
