const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

const packageJson = require("../package.json");
const serverJson = require("../server.json");
const releaseScript = fs.readFileSync("scripts/release.ps1", "utf8");

test("uses the stable topness.com MCP namespace", () => {
  assert.strictEqual(packageJson.mcpName, "com.topness/callwright");
  assert.strictEqual(serverJson.name, "com.topness/callwright");
  assert.strictEqual(packageJson.mcpName, serverJson.name);
});

test("keeps the npm package name unchanged", () => {
  assert.strictEqual(packageJson.name, "callwright");
});

test("points package metadata at the renamed GitHub repository", () => {
  assert.strictEqual(packageJson.repository.url, "git+https://github.com/topness/callwright.git");
  assert.strictEqual(packageJson.homepage, "https://github.com/topness/callwright#readme");
  assert.strictEqual(packageJson.bugs.url, "https://github.com/topness/callwright/issues");
  assert.strictEqual(packageJson.author, "topness");
});

test("points registry metadata at the renamed GitHub repository", () => {
  assert.strictEqual(serverJson.repository.url, "https://github.com/topness/callwright");
});

test("documents domain verification and the renamed GitHub login", () => {
  assert.match(releaseScript, /com\.topness domain verification/i);
  assert.match(releaseScript, /authorize as topness\)/i);
  assert.doesNotMatch(releaseScript, /topness-msft/i);
});
