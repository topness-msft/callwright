const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

test("call_analyzed returns 200 even when the Claude Routine request fails", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "callwright-webhook-"));
  const retellKey = "test-retell-key";
  process.env.RETELL_API_KEY = retellKey;
  process.env.CALLWRIGHT_DATA_DIR = dataDir;
  process.env.CLAUDE_ROUTINE_URL = "https://example.test/fire";
  process.env.CLAUDE_ROUTINE_TOKEN = "token";

  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("routine unavailable"); };
  const { app } = require("../server.js");
  const server = app.listen(0);

  try {
    const address = server.address();
    const body = JSON.stringify({
      event: "call_analyzed",
      call: {
        call_id: "call_webhook",
        metadata: {
          source: "ticktick",
          ticktick_task_id: "task_webhook",
          schema_version: 1,
        },
        retell_llm_dynamic_variables: {
          retry_max: "0",
          call_type: "general_inquiry",
        },
        disconnection_reason: "agent_hangup",
        call_analysis: {
          call_successful: true,
          custom_analysis_data: { status: "completed" },
        },
      },
    }, null, 2);
    const timestamp = Date.now();
    const digest = crypto.createHmac("sha256", retellKey)
      .update(body + timestamp)
      .digest("hex");
    const signature = `v=${timestamp},d=${digest}`;

    const response = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: address.port,
        path: "/webhook/retell",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Retell-Signature": signature,
        },
      }, (res) => {
        let responseBody = "";
        res.on("data", (chunk) => { responseBody += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body: responseBody }));
      });
      req.on("error", reject);
      req.end(body);
    });

    assert.equal(response.status, 200, response.body);
    const parsed = JSON.parse(response.body);
    assert.equal(parsed.routine_trigger.triggered, false);
    assert.equal(parsed.routine_trigger.reason, "request_failed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    global.fetch = originalFetch;
    delete process.env.RETELL_API_KEY;
    delete process.env.CALLWRIGHT_DATA_DIR;
    delete process.env.CLAUDE_ROUTINE_URL;
    delete process.env.CLAUDE_ROUTINE_TOKEN;
  }
});
