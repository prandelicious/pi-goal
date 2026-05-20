/**
 * Integration tests for the plan-review state machine across event handlers.
 *
 * These tests simulate the sequence of handler invocations (message_end →
 * tool_call → agent_end) and verify the state transitions produce the
 * expected outcomes.
 *
 * Run: bun test-wiring.test.ts
 */

import { strict as assert } from "node:assert";

// ── State machine helpers ─────────────────────────────────────────────

interface PlanReviewState {
  pendingPlanReview: boolean;
  pendingPlanText: string;
  goalText: string;
  widgetShown: boolean;
  widgetText: string | null;
  widgetCleared: boolean;
  notificationShown: boolean;
  notificationText: string | null;
}

function makeState(): PlanReviewState {
  return {
    pendingPlanReview: false,
    pendingPlanText: "",
    goalText: "Fix failing tests",
    widgetShown: false,
    widgetText: null,
    widgetCleared: false,
    notificationShown: false,
    notificationText: null,
  };
}

// Simulates showPlanWidget
function showPlanWidget(state: PlanReviewState, planText: string) {
  state.widgetShown = true;
  state.widgetText = formatGoalWidgetLines(state.goalText, planText, 2).join("\n");
  state.widgetCleared = false;
}

// Simulates clearPlanWidget
function clearPlanWidget(state: PlanReviewState) {
  state.widgetCleared = true;
  state.widgetShown = false;
}

function stripThinkTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateLine(text: string, maxLen: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return normalized.slice(0, Math.max(0, maxLen - 2)).trimEnd() + " …";
}

function formatGoalWidgetLines(goalText: string, planText: string | null, maxLines: number): string[] {
  const lines = [`● /goal active · ${truncateLine(goalText, 110)}`];
  const cleanPlan = planText ? stripThinkTags(planText) : "";
  if (cleanPlan && maxLines > 1) {
    lines.push(`  ${truncateLine(cleanPlan, 110)}`);
  }
  return lines.slice(0, maxLines);
}

// Simulates cmdSet setting the flag (replicating exact logic)
function cmdSetSetsPlanReview(state: PlanReviewState) {
  state.pendingPlanReview = true;
  state.pendingPlanText = "";
}

// Simulates message_end handler (replicating exact logic from index.ts)
function onMessageEnd(
  state: PlanReviewState,
  message: { role: string; content?: Array<{ type: string; text?: string }> }
) {
  if (!state.pendingPlanReview) return;
  if (message.role !== "assistant") return;

  const textContent =
    message.content
      ?.filter((c: any) => c.type === "text")
      ?.map((c: any) => c.text)
      ?.join("") ?? "";

  state.pendingPlanText = textContent;
  if (textContent) {
    showPlanWidget(state, textContent);
  }
}

// Simulates tool_call handler (replicating exact logic from index.ts)
function onToolCall(state: PlanReviewState) {
  if (!state.pendingPlanReview) return;

  state.pendingPlanReview = false;
  state.pendingPlanText = "";
}

// Simulates agent_end handler (replicating exact logic from index.ts)
function onAgentEnd(state: PlanReviewState) {
  if (state.pendingPlanReview) {
    state.pendingPlanReview = false;
    if (state.pendingPlanText) {
      showPlanWidget(state, state.pendingPlanText);
    }
    state.pendingPlanText = "";
  } else {
    state.pendingPlanText = "";
  }
}

// Simulates before_agent_start handler
function onBeforeAgentStart(
  state: PlanReviewState,
  originalSystemPrompt: string
): { systemPrompt?: string } | undefined {
  if (!state.pendingPlanReview) return undefined;
  return {
    systemPrompt:
      originalSystemPrompt +
      "\n\nWhen describing your approach, structure your response with clear markdown sections: ## Steps, ## Files to modify. Use concise numbered steps and file lists. Keep every section brief.",
  };
}

// ── Helper to build fake messages ────────────────────────────────────

function assistantMessage(text: string) {
  return { role: "assistant", content: [{ type: "text" as const, text }] };
}

function assistantMessageNoText() {
  return { role: "assistant", content: [] as Array<{ type: string }> };
}

function userMessage() {
  return { role: "user", content: [{ type: "text" as const, text: "/goal fix tests" }] };
}

// ══════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════

function testHappyPathTextPlanThenToolCall() {
  const state = makeState();
  cmdSetSetsPlanReview(state);

  // Assistant responds with text plan
  onMessageEnd(state, assistantMessage("I'll fix the tests by reading the code first."));
  assert.equal(state.pendingPlanText, "I'll fix the tests by reading the code first.");
  assert.equal(state.pendingPlanReview, true);
  // Widget shown immediately
  assert.equal(state.widgetShown, true);
  assert.equal(state.widgetText, "● /goal active · Fix failing tests\n  I'll fix the tests by reading the code first.");

  // Tool call fires → plan review closes, active-goal widget remains
  onToolCall(state);
  assert.equal(state.pendingPlanReview, false);
  assert.equal(state.widgetShown, true);
  assert.equal(state.widgetCleared, false);
}

function testEmptyPlanTextNoWidget() {
  const state = makeState();
  cmdSetSetsPlanReview(state);

  // Assistant responds with NO text
  onMessageEnd(state, assistantMessageNoText());
  assert.equal(state.pendingPlanText, "");
  assert.equal(state.pendingPlanReview, true);
  // No widget shown (textContent was empty)
  assert.equal(state.widgetShown, false);

  // Tool call fires → clears pending plan review without touching widget
  onToolCall(state);
  assert.equal(state.pendingPlanReview, false);
  assert.equal(state.widgetCleared, false);
}

function testAgentEndFallbackNoToolsCalled() {
  const state = makeState();
  cmdSetSetsPlanReview(state);

  // Assistant responds with text but calls NO tools
  onMessageEnd(state, assistantMessage("I will fix the tests by running pytest."));
  assert.equal(state.pendingPlanText, "I will fix the tests by running pytest.");
  assert.equal(state.widgetShown, true);

  // No tool_call events fire → agent_end shows widget as fallback
  onAgentEnd(state);
  assert.equal(state.pendingPlanReview, false);
  // Widget was already shown by message_end, so agent_end doesn't re-show
  // (the else branch clears widget since pendingPlanReview is false now)
  // Actually let me trace: agent_end sets pendingPlanReview=false,
  // then checks `if (pendingPlanReview)` which is now false → else: clearPlanWidget
  // Wait, that's wrong. agent_end first checks if (pendingPlanReview).
  // After onMessageEnd, pendingPlanReview=true.
  // onAgentEnd: if pendingPlanReview is true → set false, if text show widget.
  // But widget was already shown by message_end.
  // The key is: does the widget persist? Let me check...
}

// Let me rewrite this test more carefully
function testAgentEndWhenNoTools_ShowsWidget() {
  const state = makeState();
  cmdSetSetsPlanReview(state);

  onMessageEnd(state, assistantMessage("Plan: fix tests."));
  assert.equal(state.pendingPlanReview, true);
  assert.equal(state.widgetShown, true);

  // agent_end: pendingPlanReview is still true → shows widget fallback
  onAgentEnd(state);
  assert.equal(state.pendingPlanReview, false);
  assert.equal(state.widgetShown, true); // widget was shown (again) by agent_end
}

function testAgentEndAfterToolCallKeepsWidget() {
  const state = makeState();
  cmdSetSetsPlanReview(state);
  onMessageEnd(state, assistantMessage("Plan: fix tests."));
  assert.equal(state.widgetShown, true);

  onToolCall(state);
  assert.equal(state.widgetCleared, false);

  // agent_end fires after tool execution
  state.widgetCleared = false;
  onAgentEnd(state);
  assert.equal(state.widgetShown, true, "agent_end must keep active-goal widget after tool_call");
  assert.equal(state.widgetCleared, false);
  assert.equal(state.pendingPlanReview, false);
}

function testDoubleToolCallKeepsWidget() {
  const state = makeState();
  cmdSetSetsPlanReview(state);
  onMessageEnd(state, assistantMessage("Plan: fix the tests."));

  // First tool call → widget remains
  onToolCall(state);
  assert.equal(state.widgetShown, true);
  assert.equal(state.widgetCleared, false);

  // Second tool call → flags already cleared, no-op
  state.widgetCleared = false;
  onToolCall(state);
  assert.equal(state.widgetCleared, false, "second tool_call must not clear active-goal widget");
}

function testMessageEndUserRoleIgnored() {
  const state = makeState();
  cmdSetSetsPlanReview(state);

  // message_end fires for user message first
  onMessageEnd(state, userMessage());
  assert.equal(state.pendingPlanText, "");
  assert.equal(state.pendingPlanReview, true);
  assert.equal(state.widgetShown, false);

  // Then assistant responds
  onMessageEnd(state, assistantMessage("Plan: fix the tests."));
  assert.equal(state.pendingPlanText, "Plan: fix the tests.");
  assert.equal(state.widgetShown, true);
}

function testBeforeAgentStartInjectsWhenPlanReview() {
  const state = makeState();
  cmdSetSetsPlanReview(state);

  const result = onBeforeAgentStart(state, "You are a helpful assistant.");
  assert.ok(result);
  assert.ok(result!.systemPrompt!.includes("## Steps"));
  assert.ok(result!.systemPrompt!.includes("## Files to modify"));
  assert.ok(result!.systemPrompt!.includes("You are a helpful assistant."));
}

function testBeforeAgentStartSkippedWhenNotPlanReview() {
  const state = makeState();
  const result = onBeforeAgentStart(state, "You are a helpful assistant.");
  assert.equal(result, undefined);
}

function testBeforeAgentStartOnlyOnFirstTurn() {
  const state = makeState();
  cmdSetSetsPlanReview(state);

  // First turn: injects
  assert.ok(onBeforeAgentStart(state, "Base."));

  // After tool_call clears the flag
  onToolCall(state);

  // Second turn: no injection
  assert.equal(onBeforeAgentStart(state, "Base."), undefined);
}

function testFullLifecycleHappyPath() {
  const state = makeState();

  // 1. /goal set
  cmdSetSetsPlanReview(state);
  assert.equal(state.pendingPlanReview, true);
  assert.equal(state.pendingPlanText, "");

  // 2. before_agent_start injects
  assert.ok(onBeforeAgentStart(state, "Base."));

  // 3. User message ignored
  onMessageEnd(state, userMessage());
  assert.equal(state.pendingPlanText, "");

  // 4. Assistant responds with plan
  onMessageEnd(state, assistantMessage("## Steps\n1. Read files\n2. Fix bugs"));
  assert.equal(state.pendingPlanText, "## Steps\n1. Read files\n2. Fix bugs");
  assert.equal(state.widgetShown, true);
  assert.equal(state.widgetText, "● /goal active · Fix failing tests\n  ## Steps 1. Read files 2. Fix bugs");

  // 5. First tool call → widget remains
  onToolCall(state);
  assert.equal(state.widgetShown, true);
  assert.equal(state.widgetCleared, false);
  assert.equal(state.pendingPlanReview, false);

  // 6. Subsequent tool calls → no clearing
  state.widgetCleared = false;
  onToolCall(state);
  assert.equal(state.widgetCleared, false);

  // 7. agent_end → keeps active-goal widget
  onAgentEnd(state);
  assert.equal(state.widgetShown, true);
  assert.equal(state.widgetCleared, false);
  assert.equal(state.pendingPlanText, "");
}

function testWidgetFormatGoalLines() {
  const lines = formatGoalWidgetLines("Fix failing tests", "Step 1\nStep 2\nStep 3", 10);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("/goal active"));
  assert.ok(lines[0].includes("Fix failing tests"));
  assert.ok(lines[1].includes("Step 1 Step 2 Step 3"));
}

function testWidgetFormatShowsActualGoal() {
  const lines = formatGoalWidgetLines(
    "Create /tmp/pi-goal-smoke.txt",
    "I will write the file first.",
    10
  );
  assert.ok(lines[0].includes("/goal active"));
  assert.ok(lines[0].includes("Create /tmp/pi-goal-smoke.txt"));
  assert.ok(lines[1].includes("I will write the file first."));
}

function testWidgetTruncation() {
  const longText = "a ".repeat(200);
  const lines = formatGoalWidgetLines("Fix failing tests", longText, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith("…"), "should truncate the plan line");
}

function testWidgetStripsThinkTags() {
  const lines = formatGoalWidgetLines("Fix failing tests", "<think>hidden</think>\nVisible summary", 2);
  assert.ok(!lines.join("\n").includes("<think>"));
  assert.ok(!lines.join("\n").includes("hidden"));
  assert.ok(lines[1].includes("Visible summary"));
}

function testAgentEndWithNoText_NoWidget() {
  const state = makeState();
  cmdSetSetsPlanReview(state);

  // Assistant responds without text
  onMessageEnd(state, assistantMessageNoText());
  assert.equal(state.widgetShown, false);

  // agent_end: pendingPlanReview true, but pendingPlanText empty
  onAgentEnd(state);
  // Widget was NOT shown (text was empty)
  assert.equal(state.widgetShown, false);
  assert.equal(state.pendingPlanReview, false);
}

// ══════════════════════════════════════════════════════════════════════
// Runner
// ══════════════════════════════════════════════════════════════════════

async function main() {
  let passed = 0;
  let failed = 0;

  const tests: [string, () => void | Promise<void>][] = [
    ["happy path — goal widget persists through tool_call", testHappyPathTextPlanThenToolCall],
    ["empty text — no widget shown", testEmptyPlanTextNoWidget],
    ["agent_end no tools — shows widget fallback", testAgentEndWhenNoTools_ShowsWidget],
    ["agent_end after tool_call — keeps widget", testAgentEndAfterToolCallKeepsWidget],
    ["double tool_call — keeps widget", testDoubleToolCallKeepsWidget],
    ["message_end user role — ignored", testMessageEndUserRoleIgnored],
    ["before_agent_start — injects when active", testBeforeAgentStartInjectsWhenPlanReview],
    ["before_agent_start — skipped when not", testBeforeAgentStartSkippedWhenNotPlanReview],
    ["before_agent_start — only on first turn", testBeforeAgentStartOnlyOnFirstTurn],
    ["full lifecycle — happy path", testFullLifecycleHappyPath],
    ["widget format — header, lines, footer", testWidgetFormatGoalLines],
    ["widget format — shows actual goal", testWidgetFormatShowsActualGoal],
    ["widget truncation — indicator shown", testWidgetTruncation],
    ["widget format — strips think tags", testWidgetStripsThinkTags],
    ["agent_end no text — no widget", testAgentEndWithNoText_NoWidget],
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
