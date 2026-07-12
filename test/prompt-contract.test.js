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

test("automated-loop escalation is scoped to automation and excludes human clarification", () => {
  assert.match(prompt, /automated counterpart/i);
  assert.match(prompt, /do not apply this rule to a human/i);
  assert.match(prompt, /does not apply to hold music.*queue.*wait announcements/i);
  assert.match(prompt, /second time/i);
});

test("automated-loop escalation asks for a human, presses 0 once, then ends", () => {
  const humanIdx = prompt.search(/ask to speak with a human representative/i);
  const pressIdx = prompt.search(/press 0 exactly once/i);
  const endIdx = prompt.search(/still loops.*end the call/i);

  assert.ok(humanIdx >= 0, "ask-for-human step must be present");
  assert.ok(pressIdx > humanIdx, "press-0 step must follow ask-for-human");
  assert.ok(endIdx > pressIdx, "end-call step must follow press-0");
  assert.match(prompt, /never press 0 repeatedly/i);
  assert.match(prompt, /explicit.*digit.*human representative.*press that digit once/i);
  assert.match(prompt, /otherwise[\s\S]{0,120}press 0 exactly once/i);
  assert.match(prompt, /loop guard overrides normal IVR navigation/i);
  assert.match(prompt, /still loops after that one digit attempt/i);
  assert.match(prompt, /do not infer an answer from canned content/i);
});

test("the first automated repeat permits one clarification before escalation", () => {
  const clarifyIdx = prompt.search(/first repeat.*clarify.*once/i);
  const humanIdx = prompt.search(/ask to speak with a human representative/i);
  assert.ok(clarifyIdx >= 0, "first-repeat clarification must be present");
  assert.ok(clarifyIdx < humanIdx, "first-repeat clarification must precede escalation");
  assert.doesNotMatch(prompt, /first repeat.*(?:human representative|press 0|end the call)/i);
  assert.match(prompt, /interactive virtual receptionist repeats[\s\S]{0,100}loop guard instead/i);
});

test("Japanese prompt mirrors the automated-loop escalation ladder", () => {
  const humanIdx = japanesePrompt.search(/2回目[\s\S]{0,120}人間の担当者/);
  const pressIdx = japanesePrompt.search(/press_digit[\s\S]{0,80}0.*一度だけ/);
  const endIdx = japanesePrompt.search(/いずれかの番号を一度押した後[\s\S]{0,100}通話を終/);

  assert.ok(humanIdx >= 0, "Japanese ask-for-human step must be present");
  assert.ok(pressIdx > humanIdx, "Japanese press-0 step must follow ask-for-human");
  assert.ok(endIdx > pressIdx, "Japanese end-call step must follow press-0");
  assert.match(japanesePrompt, /人間.*適用しない/);
  assert.match(japanesePrompt, /保留音.*待機.*適用しない/);
  assert.match(japanesePrompt, /1回目.*取次.*一度だけ/);
  assert.match(japanesePrompt, /担当者.*番号.*その番号を一度だけ押す/);
  assert.match(japanesePrompt, /それ以外.*0.*一度だけ/);
  assert.match(japanesePrompt, /通常のIVR操作より.*ループ対策を優先/);
  assert.match(japanesePrompt, /0 を繰り返し押してはいけない/);
  assert.match(japanesePrompt, /定型文から答えを推測しない/);
});
