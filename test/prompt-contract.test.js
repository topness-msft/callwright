const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

const prompt = fs.readFileSync("generic-prompt.md", "utf8");
const japanesePrompt = fs.readFileSync("generic-prompt.ja.md", "utf8");

test("the mandatory full opener is scoped to a human first interactive party", () => {
  assert.doesNotMatch(prompt, /Mandatory opening[^\r\n]*every time/i);
  assert.doesNotMatch(prompt, /Mandatory opening[^\r\n]*first human interaction/i);
  assert.match(prompt, /Mandatory opening[^\r\n]*first interactive party is human/i);
});

test("virtual receptionists receive routing only before a human transfer", () => {
  assert.match(prompt, /interactive virtual receptionist/i);
  assert.match(prompt, /routing request only/i);
  assert.match(prompt, /do not ask the substantive question/i);
});

test("a transferred human gets one unresolved ask, then disclosure, then a pause", () => {
  assert.match(prompt, /ask only the first unresolved substantive question/i);
  assert.match(prompt, /immediately add the brief\s+AI disclosure/i);
  assert.match(prompt, /then\s+STOP and wait for the new person to respond/i);
  assert.doesNotMatch(prompt, /give only the brief AI disclosure/i);
  assert.match(prompt, /never replay the\s+routing request or the full original opener/i);
});

test("the first-human opening rule excludes post-transfer pickups", () => {
  assert.match(prompt, /only if this is the first interactive party/i);
  assert.match(prompt, /follow the transfer rule instead/i);
});

test("Japanese prompt preserves the same virtual-receptionist transfer contract", () => {
  assert.doesNotMatch(japanesePrompt, /毎回、最初に必ず言う/);
  assert.match(japanesePrompt, /最初に応対した相手が人間の場合のみ/);
  assert.match(japanesePrompt, /対話型の自動受付/);
  assert.match(japanesePrompt, /取次依頼だけ/);
  assert.match(japanesePrompt, /最初の未解決の\s*質問だけ/);
  assert.match(japanesePrompt, /その直後にAIである旨の短い開示/);
  assert.match(japanesePrompt, /そこで話すのをやめ/);
  assert.match(japanesePrompt, /冒頭文全体を繰り返さない/);
});
