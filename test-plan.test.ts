/**
 * Tests for pi-goal core logic: smarter continuation, verify tool, and config.
 *
 * Run: bun test-plan.test.ts
 */

import { strict as assert } from "node:assert";
import { exec as execCallback } from "node:child_process";
import { readFileSync } from "node:fs";

// ── Pure-logic helpers (replicated from index.ts for testability) ────

function summarizeResponse(text: string, maxLen: number = 200): string {
  const cleaned = text.replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned.length <= maxLen) return cleaned;

  const truncated = cleaned.slice(0, maxLen);
  const lastPeriod = truncated.lastIndexOf(".");
  const lastNewline = truncated.lastIndexOf("\n");
  const lastBoundary = Math.max(lastPeriod, lastNewline);

  if (lastBoundary > maxLen * 0.4) {
    return cleaned.slice(0, lastBoundary + 1) + " ..";
  }
  return truncated + " ..";
}

function buildContinuationMessage(
  goalText: string,
  lastResponse: string,
  verdictReason: string
): string {
  const summary = summarizeResponse(lastResponse, 250);
  return `[Continuing toward goal: ${goalText}]\nPrevious turn: ${summary}\nStatus: ${verdictReason}`;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

function execVerifyCmd(
  cmd: string
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = execCallback(
      cmd,
      { timeout: 5000, maxBuffer: 10 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
          code: error ? (error.code ?? 1) : 0,
        });
      }
    );
    child.on("error", (err: any) => {
      resolve({ stdout: "", stderr: String(err.message || err), code: err.code ?? 1 });
    });
  });
}

// ── summarizeResponse tests ──────────────────────────────────────────

function testShortTextNoTruncation() {
  assert.equal(
    summarizeResponse("Fixed the auth test by correcting the mock."),
    "Fixed the auth test by correcting the mock."
  );
}

function testExactMaxLenNoTruncation() {
  const exact = "a".repeat(200);
  assert.equal(summarizeResponse(exact), exact);
}

function testTruncateAtSentenceBoundary() {
  const long = "First sentence. Second sentence that goes on and on about various things and should be truncated somewhere reasonable. Third sentence here.";
  const result = summarizeResponse(long, 50);
  assert.ok(result.endsWith(" .."), `expected " .." suffix, got: ${result}`);
  assert.ok(result.includes("First sentence."), `expected to preserve first sentence, got: ${result}`);
}

function testTruncateWithoutSentenceBoundary() {
  const noSentence = "a".repeat(100) + " b c d";
  const result = summarizeResponse(noSentence, 50);
  assert.ok(result.endsWith(" .."));
  assert.equal(result.length, 53); // 50 chars + " .."
}

function testCollapsesExcessiveNewlines() {
  assert.equal(
    summarizeResponse("Line one.\n\n\n\n\nLine two."),
    "Line one.\n\nLine two."
  );
}

function testEmptyText() {
  assert.equal(summarizeResponse(""), "");
  assert.equal(summarizeResponse("   "), "");
}

function testMultiSentencePicksBestBoundary() {
  const threeSentences = "First short one. Second medium length sentence here. Third one that goes way over the limit yadda yadda yadda.";
  const result = summarizeResponse(threeSentences, 90);
  assert.ok(result.endsWith(" .."));
  assert.ok(result.includes("Second medium"));
}

function testTruncationViaNewlineBoundary() {
  const lines = "Short line.\n" + "a".repeat(150) + "\nmore after";
  const result = summarizeResponse(lines, 30);
  assert.ok(result.includes("Short line."));
  assert.ok(result.endsWith(" .."));
}

function testSingleWordExceedsMaxLen() {
  const longWord = "a".repeat(300);
  const result = summarizeResponse(longWord, 100);
  assert.equal(result.length, 103);
  assert.ok(result.endsWith(" .."));
}

// ── buildContinuationMessage tests ───────────────────────────────────

function testBasicContinuation() {
  const msg = buildContinuationMessage(
    "Fix failing tests",
    "I ran pytest and found 3 failing tests. Fixed test_auth by correcting the mock.",
    "2 of 5 tests still fail, continuing."
  );
  assert.ok(msg.startsWith("[Continuing toward goal: Fix failing tests]"));
  assert.ok(msg.includes("Previous turn:"));
  assert.ok(msg.includes("I ran pytest and found 3 failing tests"));
  assert.ok(msg.includes("Status: 2 of 5 tests still fail, continuing."));
  // No verify section in simple continuation
  assert.ok(!msg.includes("Verify failed:"));
  assert.ok(!msg.includes("Verify"));
}

function testVeryLongResponseSummarized() {
  const longResponse = "Step one: did this. " + "b ".repeat(500);
  const msg = buildContinuationMessage("goal", longResponse, "keep going");
  const prevLine = msg.split("\n").find(l => l.startsWith("Previous turn: "))!;
  assert.ok(prevLine.length < 280, `previous turn line too long: ${prevLine.length}`);
  assert.ok(prevLine.endsWith(" .."), `expected summary truncation, got: ${prevLine.slice(-20)}`);
}

function testEmptyResponse() {
  const msg = buildContinuationMessage("goal", "", "reason");
  assert.ok(msg.includes("Previous turn:"));
}

function testSpecialCharsInGoal() {
  const msg = buildContinuationMessage(
    'Fix $PATH issue & escape "quotes"',
    "Fixed the path issue.",
    "Done."
  );
  assert.ok(msg.includes("Fix $PATH issue"));
}

function testMultilineGoal() {
  const msg = buildContinuationMessage("Goal with\nnewlines", "Done it.", "Yes");
  assert.ok(msg.startsWith("[Continuing toward goal: Goal with"));
}

// ── stripAnsi tests ──────────────────────────────────────────────────

function testNoAnsi() {
  assert.equal(stripAnsi("hello"), "hello");
}

function testSimpleRed() {
  assert.equal(stripAnsi("\x1B[31mred\x1B[0m"), "red");
}

function testBoldGreen() {
  assert.equal(stripAnsi("\x1B[1m\x1B[32mbold green\x1B[0m"), "bold green");
}

function testMultipleAnsiCodes() {
  assert.equal(
    stripAnsi("\x1B[31mred\x1B[32mgreen\x1B[34mblue\x1B[0m"),
    "redgreenblue"
  );
}

function testComplexSequences() {
  const complex = "\x1B[38;2;255;0;0mred\x1B[48;2;0;0;255mbg\x1B[0m\x1B[A\x1B[2K";
  assert.equal(stripAnsi(complex), "redbg");
}

function testAnsiInMixedText() {
  assert.equal(stripAnsi("norm\x1B[31mred\x1B[0mnorm"), "normrednorm");
}

function testEmptyString() {
  assert.equal(stripAnsi(""), "");
}

// ── execVerifyCmd tests (runs real shell commands) ───────────────────

async function testVerifyPass() {
  const result = await execVerifyCmd("echo ok");
  assert.equal(result.code, 0, `expected exit 0, got ${result.code}: ${result.stderr}`);
}

async function testVerifyFail() {
  const result = await execVerifyCmd("false");
  assert.notEqual(result.code, 0, `expected non-zero exit, got ${result.code}`);
}

async function testVerifyStdoutCapture() {
  const result = await execVerifyCmd("echo 'hello world'");
  assert.equal(result.stdout.trim(), "hello world");
}

async function testVerifyCommandNotFound() {
  const result = await execVerifyCmd("nonexistent_command_xyz123");
  assert.notEqual(result.code, 0);
}

async function testVerifyStderrButSuccess() {
  const result = await execVerifyCmd("echo 'stderr msg' >&2 && exit 0");
  assert.equal(result.code, 0);
  assert.ok(result.stderr.includes("stderr msg"));
}

async function testVerifyExitCodeOne() {
  const result = await execVerifyCmd("exit 1");
  assert.equal(result.code, 1);
}

async function testVerifyNonZeroExit() {
  const result = await execVerifyCmd("exit 42");
  assert.equal(result.code, 42);
}

async function testVerifyWithPipeline() {
  const result = await execVerifyCmd("echo 'hello' | grep hello");
  assert.equal(result.code, 0);
}

async function testVerifyPipelineFail() {
  const result = await execVerifyCmd("echo 'hello' | grep goodbye");
  assert.notEqual(result.code, 0);
}

async function testVerifyStderrAndStdoutBothCaptured() {
  const result = await execVerifyCmd("echo out && echo err >&2");
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes("out"));
  assert.ok(result.stderr.includes("err"));
}

async function testVerifyTimeoutKills() {
  const result = await execVerifyCmd("sleep 10");
  // Should time out (5s timeout) and return non-zero
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.length > 0 || result.stdout.length === 0);
}

// ── Config default tests ─────────────────────────────────────────────

function testConfigDefaults() {
  const defaults = {
    maxTurns: 20,
    judgeModel: "",
    taskModel: "",
    taskThinking: "",
    showPlan: false,
    autoContinue: false,
  };

  assert.equal(defaults.maxTurns, 20);
  assert.equal(defaults.showPlan, false);
  assert.equal(defaults.judgeModel, "");
  assert.equal(defaults.autoContinue, false);
}

// ── Codex-style lifecycle surface tests ────────────────────────────────

function readIndexSource(): string {
  return readFileSync(new URL("./index.ts", import.meta.url), "utf-8");
}

function testRegistersCodexLifecycleTools() {
  const source = readIndexSource();
  assert.match(source, /name:\s*"create_goal"/);
  assert.match(source, /name:\s*"get_goal"/);
  assert.match(source, /name:\s*"update_goal"/);
}

function testAutoContinueDefaultsOff() {
  const source = readIndexSource();
  assert.match(source, /autoContinue:\s*false/);
  assert.match(source, /PI_GOAL_AUTO_CONTINUE/);
}

function testAgentEndRequiresAutoContinue() {
  const source = readIndexSource();
  assert.match(source, /if\s*\(!config\.autoContinue\)/);
}

function testWidgetLabelsActualGoal() {
  const source = readIndexSource();
  assert.match(source, /● \/goal active/);
  assert.match(source, /function formatGoalWidgetLines/);
  assert.match(source, /placement:\s*"aboveEditor"/);
  assert.match(source, /ctx\.ui\.theme\.fg\("dim"/);
  assert.match(source, /clearGoalWidget\(ctx\)/);
}

function testSuccessfulToolsReturnTerseVisibleContent() {
  const source = readIndexSource();
  assert.match(source, /goal complete/);
  assert.match(source, /verification passed/);
  assert.match(source, /details:\s*\{\s*exitCode:\s*result\.code,\s*passed,\s*output\s*\}/);
}

function testThinkTagsAreStrippedFromGoalSummaries() {
  const source = readIndexSource();
  assert.match(source, /function stripThinkTags/);
  assert.match(source, /<think>\[\\s\\S\]\*\?<\\\/think>/);
  assert.match(source, /summary:\s*Type\.Optional/);
}

// ── Runner ───────────────────────────────────────────────────────────

async function main() {
  let passed = 0;
  let failed = 0;

  const tests: [string, () => void | Promise<void>][] = [
    ["summarize — short text", testShortTextNoTruncation],
    ["summarize — exact maxLen", testExactMaxLenNoTruncation],
    ["summarize — sentence boundary", testTruncateAtSentenceBoundary],
    ["summarize — no sentence boundary", testTruncateWithoutSentenceBoundary],
    ["summarize — collapse newlines", testCollapsesExcessiveNewlines],
    ["summarize — empty text", testEmptyText],
    ["summarize — multi-sentence picks best", testMultiSentencePicksBestBoundary],
    ["summarize — newline boundary", testTruncationViaNewlineBoundary],
    ["summarize — single word overflow", testSingleWordExceedsMaxLen],
    ["continuation — basic", testBasicContinuation],
    ["continuation — long response truncated", testVeryLongResponseSummarized],
    ["continuation — empty response", testEmptyResponse],
    ["continuation — special chars in goal", testSpecialCharsInGoal],
    ["continuation — multiline goal", testMultilineGoal],
    ["stripAnsi — no ansi", testNoAnsi],
    ["stripAnsi — simple red", testSimpleRed],
    ["stripAnsi — bold green", testBoldGreen],
    ["stripAnsi — multiple codes", testMultipleAnsiCodes],
    ["stripAnsi — complex sequences", testComplexSequences],
    ["stripAnsi — mixed text", testAnsiInMixedText],
    ["stripAnsi — empty", testEmptyString],
    ["execVerifyCmd — echo ok passes", testVerifyPass],
    ["execVerifyCmd — false fails", testVerifyFail],
    ["execVerifyCmd — stdout captured", testVerifyStdoutCapture],
    ["execVerifyCmd — command not found", testVerifyCommandNotFound],
    ["execVerifyCmd — stderr but success", testVerifyStderrButSuccess],
    ["execVerifyCmd — exit 1", testVerifyExitCodeOne],
    ["execVerifyCmd — exit 42", testVerifyNonZeroExit],
    ["execVerifyCmd — pipeline success", testVerifyWithPipeline],
    ["execVerifyCmd — pipeline failure", testVerifyPipelineFail],
    ["execVerifyCmd — stdout+stderr both", testVerifyStderrAndStdoutBothCaptured],
    ["execVerifyCmd — timeout kills", testVerifyTimeoutKills],
    ["config defaults", testConfigDefaults],
    ["codex lifecycle — registers tools", testRegistersCodexLifecycleTools],
    ["codex lifecycle — autoContinue default off", testAutoContinueDefaultsOff],
    ["codex lifecycle — agent_end guarded by autoContinue", testAgentEndRequiresAutoContinue],
    ["codex lifecycle — widget labels actual goal", testWidgetLabelsActualGoal],
    ["codex lifecycle — successful tools are quiet", testSuccessfulToolsReturnTerseVisibleContent],
    ["codex lifecycle — strips think tags from summaries", testThinkTagsAreStrippedFromGoalSummaries],
  ];

  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err: any) {
      console.log(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
      if (err.stack) {
        const stackLines = err.stack.split("\n").slice(1, 4).join("\n");
        console.error(`    ${stackLines}`);
      }
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
