// pi-goal — Codex-style standing goal state for pi
// Inspired by Hermes Agent's /goal and Codex CLI's goal feature.
//
// When to use /goal: task has a clear finish line but the path is uncertain.
// Good for performance optimization, flaky test investigation, dependency
// migrations, bug hunts, multi-step refactors, benchmark-driven tuning, and
// research tasks. Use a normal prompt for one-off edits.
//
// Config file: ~/.pi/agent/pi-goal.json
//   autoContinue   — enable the legacy judge continuation loop (default false)
//   maxTurns       — legacy auto-continue budget before auto-pause (default 20)
//   judgeModel     — provider/model-id for the judge (default: current model)
//   taskModel      — provider/model-id for the task execution (default: current model)
//   taskThinking   — thinking level for task execution (default: unchanged)
//
// Env var fallback (overrides pi-goal.json):
//   PI_GOAL_AUTO_CONTINUE, PI_GOAL_MAX_TURNS, PI_GOAL_JUDGE_MODEL
//
// Plan preview:
//   showPlan         — Add the LLM's inferred plan to the compact goal widget (default false)
//   PI_GOAL_SHOW_PLAN — Env var toggle for plan preview
//
// Custom tool:
//   create_goal      — Create a durable active goal with optional token budget.
//   get_goal         — Inspect active goal state and usage.
//   update_goal      — Mark the active goal complete.
//   run_verify       — Tool the LLM can call to run verification commands (e.g., pytest).
//                     The result can be used as completion evidence.
//
// Debug:
//   PI_GOAL_DEBUG=true       — Enable debug log to /tmp/pi-goal.log (or PI_GOAL_LOG=path)
//
// Usage:
//   /goal <text>      — Set a standing goal and kick off the first turn if none is active
//   /goal status      — Show current goal and usage
//   /goal pause       — Pause the legacy auto-continuation loop
//   /goal resume      — Resume the legacy loop (resets turn counter to zero)
//   /goal clear       — Drop the goal entirely
//   /goal dismiss     — Hide the goal widget

import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Model, Api } from "@earendil-works/pi-coding-agent";
import { exec as execCallback } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

const ENTRY_TYPE = "pi-goal";

// ── Logger ────────────────────────────────────────────────────────────

const DEBUG = process.env.PI_GOAL_DEBUG === "true";
const LOG_PATH = process.env.PI_GOAL_LOG || "/tmp/pi-goal.log";

function log(...args: unknown[]) {
  if (!DEBUG) return;
  try {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
    appendFileSync(LOG_PATH, line);
  } catch { /* best-effort */ }
}

function planLog(...args: unknown[]) {
  // Always write plan-review logs (not gated behind DEBUG)
  try {
    const ts = new Date().toISOString();
    const line = `[PLAN ${ts}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
    appendFileSync(LOG_PATH, line);
  } catch { /* best-effort */ }
}

// ── Config loader ─────────────────────────────────────────────────────

interface GoalConfig {
  autoContinue: boolean;
  maxTurns: number;
  judgeModel: string;
  taskModel: string;
  taskThinking: string;
  showPlan: boolean;
}

function loadConfig(): GoalConfig {
  const defaults: GoalConfig = {
    autoContinue: false,
    maxTurns: 20,
    judgeModel: "",
    taskModel: "",
    taskThinking: "",
    showPlan: false,
  };

  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    const configPath = join(homeDir, ".pi", "agent", "pi-goal.json");
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    return {
      autoContinue: raw.autoContinue ?? defaults.autoContinue,
      maxTurns: raw.maxTurns ?? defaults.maxTurns,
      judgeModel: raw.judgeModel ?? defaults.judgeModel,
      taskModel: raw.taskModel ?? defaults.taskModel,
      taskThinking: raw.taskThinking ?? defaults.taskThinking,
      showPlan: raw.showPlan ?? defaults.showPlan,
    };
  } catch {
    return defaults;
  }
}

function resolveConfig(): GoalConfig {
  const file = loadConfig();
  return {
    autoContinue:
      process.env.PI_GOAL_AUTO_CONTINUE !== undefined
        ? process.env.PI_GOAL_AUTO_CONTINUE === "true"
        : file.autoContinue,
    maxTurns: parseInt(process.env.PI_GOAL_MAX_TURNS || String(file.maxTurns), 10),
    judgeModel: process.env.PI_GOAL_JUDGE_MODEL || file.judgeModel,
    taskModel: process.env.PI_GOAL_TASK_MODEL || file.taskModel,
    taskThinking: process.env.PI_GOAL_TASK_THINKING || file.taskThinking,
    showPlan: process.env.PI_GOAL_SHOW_PLAN !== undefined ? process.env.PI_GOAL_SHOW_PLAN === "true" : file.showPlan,
  };
}

const config = resolveConfig();

// ── Types ─────────────────────────────────────────────────────────────

interface GoalState {
  text: string;
  objective?: string;
  status: "active" | "paused" | "done" | "complete";
  tokenBudget?: number;
  turnsUsed: number;
  maxTurns: number;
  createdAt: number;
  completedAt?: number;
  summary?: string;
}

interface JudgeVerdict {
  done: boolean;
  reason: string;
  pauseForSafety?: boolean;
}

interface ClearedSentinel {
  status: "cleared";
  clearedAt: number;
}

// ── Runtime state (per-extension-instance, restored from session) ─────

let goal: GoalState | null = null;
let previousModel: Model<Api> | undefined = undefined;
let previousThinking: string | undefined = undefined;
let activeAbortCleanup: (() => void) | undefined = undefined;
let pendingPlanReview = false;
let pendingPlanText = "";

// ── Persistence ───────────────────────────────────────────────────────

function restoreGoal(ctx: ExtensionContext) {
  const entries = ctx.sessionManager.getEntries();
  const goalEntries = entries.filter(
    (e: any) => e.type === "custom" && e.customType === ENTRY_TYPE
  );
  if (goalEntries.length === 0) {
    goal = null;
    return;
  }
  const latest = goalEntries[goalEntries.length - 1];
  const data = latest.data as GoalState | ClearedSentinel;
  if ((data as ClearedSentinel).status === "cleared") {
    goal = null;
    return;
  }
  goal = data as GoalState;
}

function persistGoal(pi: ExtensionAPI, g: GoalState | null) {
  if (g) {
    pi.appendEntry(ENTRY_TYPE, g);
  }
}

function getObjective(g: GoalState): string {
  return g.objective ?? g.text;
}

function isActiveGoal(g: GoalState | null): g is GoalState {
  return Boolean(g && g.status === "active");
}

function goalSnapshot(g: GoalState) {
  return {
    status: g.status === "done" ? "complete" : g.status,
    objective: getObjective(g),
    tokenBudget: g.tokenBudget ?? null,
    tokenUsage: null,
    turnsUsed: g.turnsUsed,
    maxTurns: config.autoContinue ? g.maxTurns : null,
    createdAt: new Date(g.createdAt).toISOString(),
    completedAt: g.completedAt ? new Date(g.completedAt).toISOString() : null,
  };
}

function formatGoalSnapshot(g: GoalState): string {
  const snapshot = goalSnapshot(g);
  const budget =
    snapshot.tokenBudget === null
      ? "token budget: none"
      : `token budget: ${snapshot.tokenBudget}; token usage: unavailable`;
  return [
    `status: ${snapshot.status}`,
    `objective: ${snapshot.objective}`,
    budget,
    `turns used: ${snapshot.turnsUsed}`,
  ].join("\n");
}

function createGoalState(objective: string, tokenBudget?: number): GoalState {
  return {
    text: objective,
    objective,
    status: "active",
    tokenBudget,
    turnsUsed: 0,
    maxTurns: config.maxTurns,
    createdAt: Date.now(),
  };
}

function stripThinkTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function markGoalComplete(pi: ExtensionAPI, ctx: ExtensionContext, summary?: string): Promise<GoalState | null> {
  if (!goal) return null;
  const cleanSummary = summary ? stripThinkTags(summary) : undefined;
  goal.status = "complete";
  goal.completedAt = Date.now();
  goal.summary = cleanSummary;
  persistGoal(pi, goal);
  clearGoalFooter(ctx);
  clearGoalWidget(ctx);
  pendingPlanReview = false;
  pendingPlanText = "";
  await restoreModelAndThinking(pi, ctx);
  return goal;
}

// ── Message extraction ─────────────────────────────────────────────────

function getLastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && Array.isArray(m.content)) {
      return m.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
    }
  }
  return "";
}

// ── Model resolution ──────────────────────────────────────────────────

function resolveModel(ctx: ExtensionContext, spec: string): Model<Api> | null {
  if (!spec) return null;
  const parts = spec.split("/");
  if (parts.length >= 2) {
    const provider = parts[0];
    const modelId = parts.slice(1).join("/");
    return ctx.modelRegistry.find(provider, modelId) ?? null;
  }
  return null;
}

async function switchToTaskModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
  const taskModel = resolveModel(ctx, config.taskModel);
  if (!taskModel) return false;

  previousModel = ctx.model ?? undefined;
  previousThinking = pi.getThinkingLevel();

  const success = await pi.setModel(taskModel);
  if (!success) return false;

  if (config.taskThinking) {
    pi.setThinkingLevel(config.taskThinking as any);
  }

  ctx.ui.notify(`Switched to task model: ${taskModel.provider}/${taskModel.id}`, "info");
  return true;
}

async function restoreModelAndThinking(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (previousModel) {
    const restored = await pi.setModel(previousModel);
    if (restored) {
      ctx.ui.notify(`Restored model: ${previousModel.provider}/${previousModel.id}`, "info");
    }
    previousModel = undefined;
  }
  if (previousThinking !== undefined) {
    pi.setThinkingLevel(previousThinking);
    previousThinking = undefined;
  }
}

// ── Judge ──────────────────────────────────────────────────────────────

async function judge(
  goalText: string,
  assistantResponse: string,
  ctx: ExtensionContext
): Promise<JudgeVerdict> {
  const model = resolveModel(ctx, config.judgeModel) ?? ctx.model ?? null;
  if (!model) {
    log("judge: no model available");
    return { done: false, reason: "No judge model available, continuing" };
  }

  log("judge: model =", `${model.provider}/${model.id}`, "| response length =", assistantResponse.length);

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    log("judge: auth failed —", auth.error);
    return { done: false, reason: `No auth for judge model (${auth.error}), continuing` };
  }

  const prompt = `You are a goal-completion judge. Reply with strict JSON only.
Do not include reasoning, markdown, prose, or <think> tags. Your first character must be { and your last character must be }.

GOAL: ${goalText}

ASSISTANT'S LATEST RESPONSE:
"""
${assistantResponse.slice(0, 4000)}
"""

Has the goal been achieved?
Format: {"done": boolean, "reason": "one sentence rationale"}

Rules:
- Mark done ONLY if the response explicitly confirms completion, the deliverable is clearly produced, or the goal is unachievable/blocked.
- If the assistant used the run_verify tool, treat its structured details as authoritative evidence.
- Be conservative — prefer false negatives over false positives.
- If work clearly remains, mark done as false.`;

  try {
    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: Date.now(),
    };

    let providerStatus: number | undefined;
    const response = await complete(
      model,
      {
        systemPrompt: "You are a goal-completion judge. Reply with strict JSON only. Do not include reasoning, markdown, prose, or <think> tags.",
        messages: [userMessage],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: ctx.signal,
        maxTokens: 1000,
        temperature: 0,
        reasoning: "off",
        onResponse: (res) => {
          providerStatus = res.status;
          log("judge: provider status =", res.status);
        },
      }
    );

    if (response.stopReason === "aborted") {
      return {
        done: false,
        reason: "Judge call was interrupted; pausing goal loop for safety",
        pauseForSafety: true,
      };
    }

    if (providerStatus !== undefined && (providerStatus < 200 || providerStatus >= 300)) {
      return {
        done: false,
        reason: `Judge API error ${providerStatus}; pausing goal loop for safety`,
        pauseForSafety: true,
      };
    }

    if (response.stopReason === "length") {
      log("judge: length stop before JSON");
      return {
        done: false,
        reason: "Judge response was truncated before JSON; pausing goal loop for safety",
        pauseForSafety: true,
      };
    }

    if (response.stopReason === "error") {
      log("judge: error response =", response.errorMessage || "unknown error");
      return {
        done: false,
        reason: `Judge error (${response.errorMessage || "unknown error"}); pausing goal loop for safety`,
        pauseForSafety: true,
      };
    }

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");

    log(
      "judge: response meta =",
      JSON.stringify({
        stopReason: response.stopReason,
        contentTypes: response.content.map((c: any) => c.type),
        errorMessage: response.errorMessage,
      })
    );
    log("judge: raw response =", text.slice(0, 500));

    if (!text.trim()) {
      log("judge: empty response");
      return {
        done: false,
        reason: "Judge returned an empty response; pausing goal loop for safety",
        pauseForSafety: true,
      };
    }

    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) {
      log("judge: no JSON found in response");
      return {
        done: false,
        reason: "Judge returned non-JSON; pausing goal loop for safety",
        pauseForSafety: true,
      };
    }

    const verdict = JSON.parse(match[0]);
    log("judge: verdict =", verdict);
    return {
      done: Boolean(verdict.done),
      reason: String(verdict.reason || "Continuing toward goal"),
    };
  } catch (err: any) {
    log("judge: exception —", err.message);
    if (ctx.signal?.aborted || err?.name === "AbortError") {
      return {
        done: false,
        reason: "Judge call was interrupted; pausing goal loop for safety",
        pauseForSafety: true,
      };
    }
    return {
      done: false,
      reason: `Judge error (${err.message}); pausing goal loop for safety`,
      pauseForSafety: true,
    };
  }
}

// ── UI helpers ─────────────────────────────────────────────────────────

function elapsed(createdAt: number): string {
  const totalSecs = Math.floor((Date.now() - createdAt) / 1000);
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;

  if (hrs > 0) return `${hrs}h${mins}m${secs}s`;
  if (mins > 0) return `${mins}m${secs}s`;
  return `${secs}s`;
}

function formatStatus(g: GoalState): string {
  if (g.status === "active") {
    return `◎ /goal active (${elapsed(g.createdAt)})`;
  }
  if (g.status === "paused") {
    return `◎ /goal paused`;
  }
  return `◎ /goal complete`;
}

const STATUS_KEY = "pi-goal";
let footerTimer: ReturnType<typeof setInterval> | undefined;

function stopFooterTimer() {
  if (footerTimer) {
    clearInterval(footerTimer);
    footerTimer = undefined;
  }
}

function detachAbortHandler() {
  if (activeAbortCleanup) {
    activeAbortCleanup();
    activeAbortCleanup = undefined;
  }
}

function attachGoalAbortHandler(pi: ExtensionAPI, ctx: ExtensionContext) {
  detachAbortHandler();
  if (!ctx.signal) return;

  const onAbort = () => {
    if (!goal || goal.status !== "active") return;
    log("agent aborted — pausing goal and stopping footer timer");
    goal.status = "paused";
    persistGoal(pi, goal);
    ctx.ui.notify("⏸ Goal paused — agent run was interrupted. /goal resume to continue.", "warning");
    setPausedStatus(ctx);
    void restoreModelAndThinking(pi, ctx);
  };

  ctx.signal.addEventListener("abort", onAbort, { once: true });
  activeAbortCleanup = () => ctx.signal?.removeEventListener("abort", onAbort);
}

function setGoalStatus(ctx: ExtensionContext, text: string, tone: "accent" | "dim" = "accent") {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(tone, text));
}

function startGoalActiveFooter(ctx: ExtensionContext) {
  if (!ctx.hasUI || !goal) return;

  // Use setStatus so pi's built-in footer stays intact and this extension only
  // appends its own right-aligned footer status.
  stopFooterTimer();
  const update = () => {
    if (goal?.status === "active") {
      setGoalStatus(ctx, `◎ /goal active (${elapsed(goal.createdAt)})`);
    }
  };
  update();
  footerTimer = setInterval(update, 1000);
}

function setPausedStatus(ctx: ExtensionContext) {
  detachAbortHandler();
  stopFooterTimer();
  setGoalStatus(ctx, "◎ /goal paused", "dim");
}

function clearGoalFooter(ctx: ExtensionContext) {
  detachAbortHandler();
  stopFooterTimer();
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, undefined);
}

// ── Active goal widget ────────────────────────────────────────────────

const PLAN_WIDGET_ID = "pi-goal-plan";

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

function dimLines(ctx: ExtensionContext, lines: string[]): string[] {
  return lines.map((line) => ctx.ui.theme.fg("dim", line));
}

function showGoalWidget(ctx: ExtensionContext, goalText: string, planText: string | null = null) {
  if (!ctx.hasUI) {
    planLog("widget skipped — no UI");
    ctx.ui.notify(`⊙ Goal: ${goalText.slice(0, 300)}`, "info");
    return;
  }
  planLog("setting widget — goal", goalText.length, "chars; plan", planText?.length ?? 0, "chars");
  ctx.ui.setWidget(PLAN_WIDGET_ID, dimLines(ctx, formatGoalWidgetLines(goalText, planText, 2)), {
    placement: "aboveEditor",
  });
}

function clearGoalWidget(ctx: ExtensionContext) {
  planLog("clearing widget");
  ctx.ui.setWidget(PLAN_WIDGET_ID, undefined);
}

// ── Continuation message ───────────────────────────────────────────────

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

// ── Verify runner (used by the run_verify tool) ────────────────────────

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

function execVerifyCmd(
  cmd: string,
  cwd: string
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = execCallback(
      cmd,
      { cwd, timeout: 120_000, maxBuffer: 10 * 1024 },
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

// ── Command handlers ─────────────────────────────────────────────────

async function cmdStatus(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (!goal) {
    ctx.ui.notify("No active goal. Use /goal <text> to set one.", "info");
    return;
  }
  ctx.ui.notify(`${formatStatus(goal)}\n${formatGoalSnapshot(goal)}`, goal.status === "complete" || goal.status === "done" ? "success" : "info");
}

async function cmdSet(text: string, pi: ExtensionAPI, ctx: ExtensionContext) {
  log("cmd: set —", text);
  if (isActiveGoal(goal)) {
    ctx.ui.notify(`Existing goal remains active.\n${formatGoalSnapshot(goal)}`, "info");
    return;
  }

  // Restore any leftover model state from a previous goal
  if (previousModel) {
    await restoreModelAndThinking(pi, ctx);
  }

  goal = createGoalState(text);

  persistGoal(pi, goal);
  const budgetText = config.autoContinue ? `${goal.maxTurns}-turn legacy budget` : "explicit completion";
  ctx.ui.notify(`⊙ Goal set (${budgetText}): ${text}`, "info");

  startGoalActiveFooter(ctx);
  showGoalWidget(ctx, text);

  // Switch to task model if configured
  if (config.taskModel) {
    await switchToTaskModel(pi, ctx);
  }

  if (config.showPlan) {
    pendingPlanReview = true;
    pendingPlanText = "";
    planLog("cmdSet: plan review armed for goal —", text.slice(0, 80));
  }

  // Kick off the first turn immediately
  pi.sendUserMessage(text);
}

async function cmdPause(pi: ExtensionAPI, ctx: ExtensionContext) {
  log("cmd: pause");
  if (!goal) {
    ctx.ui.notify("No active goal to pause.", "warning");
    return;
  }
  if (goal.status !== "active") {
    ctx.ui.notify(`Goal is already ${goal.status}.`, "info");
    return;
  }
  goal.status = "paused";
  persistGoal(pi, goal);
  ctx.ui.notify(`⏸ Goal paused — ${goal.turnsUsed}/${goal.maxTurns} turns used.`, "info");
  setPausedStatus(ctx);
  pendingPlanReview = false;
  pendingPlanText = "";
  await restoreModelAndThinking(pi, ctx);
}

async function cmdResume(pi: ExtensionAPI, ctx: ExtensionContext) {
  log("cmd: resume");
  if (!goal) {
    ctx.ui.notify("No goal to resume. Use /goal <text> to set one.", "warning");
    return;
  }
  if (goal.status === "active") {
    ctx.ui.notify("Goal is already active.", "info");
    return;
  }
  if (goal.status === "done" || goal.status === "complete") {
    ctx.ui.notify("Goal is complete. /goal clear to start a new one.", "info");
    return;
  }
  goal.status = "active";
  goal.turnsUsed = 0;
  persistGoal(pi, goal);
  ctx.ui.notify(`⊙ Goal resumed (${goal.maxTurns} turns reset): ${goal.text}`, "info");

  if (config.taskModel) {
    await switchToTaskModel(pi, ctx);
  }

  startGoalActiveFooter(ctx);
  showGoalWidget(ctx, getObjective(goal));

  pi.sendUserMessage(`[Continuing toward your standing goal: ${goal.text}]`);
}

async function cmdClear(pi: ExtensionAPI, ctx: ExtensionContext) {
  log("cmd: clear");
  if (!goal) {
    ctx.ui.notify("No goal to clear.", "info");
    return;
  }
  goal = null;
  pi.appendEntry(ENTRY_TYPE, { status: "cleared", clearedAt: Date.now() } as ClearedSentinel);
  ctx.ui.notify("✗ Goal cleared.", "info");
  clearGoalFooter(ctx);
  clearGoalWidget(ctx);
  pendingPlanReview = false;
  pendingPlanText = "";
  await restoreModelAndThinking(pi, ctx);
}

async function cmdDismiss(ctx: ExtensionContext) {
  clearGoalWidget(ctx);
  ctx.ui.notify("Goal summary dismissed.", "info");
}

// ── Extension factory ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerCommand("goal", {
    description: "Set, pause, resume, or clear a standing goal",
    handler: async (args, ctx) => {
      if (!args || args === "status") {
        await cmdStatus(pi, ctx);
      } else if (args === "pause") {
        await cmdPause(pi, ctx);
      } else if (args === "resume") {
        await cmdResume(pi, ctx);
      } else if (args === "clear") {
        await cmdClear(pi, ctx);
      } else if (args === "dismiss") {
        await cmdDismiss(ctx);
      } else {
        await cmdSet(args, pi, ctx);
      }
    },
  });

  // ── Codex-style goal lifecycle tools ──────────────────────────────────

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description:
      "Create a durable active goal. If a goal is already active, leave it unchanged and inspect it with get_goal.",
    promptSnippet: "Create a durable goal before starting multi-turn work",
    promptGuidelines: [
      "Use create_goal when the user invokes /goal and there is no active goal.",
      "Do not overwrite an existing active goal; call get_goal if one already exists.",
    ],
    parameters: Type.Object({
      objective: Type.String({ description: "Concrete objective to pursue." }),
      token_budget: Type.Optional(Type.Number({ description: "Optional token budget for the goal." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (isActiveGoal(goal)) {
        return {
          content: [{ type: "text", text: `Existing goal remains active.\n${formatGoalSnapshot(goal)}` }],
          details: goalSnapshot(goal),
        };
      }

      goal = createGoalState(params.objective, params.token_budget);
      persistGoal(pi, goal);
      startGoalActiveFooter(ctx);
      showGoalWidget(ctx, getObjective(goal));

      if (config.taskModel) {
        await switchToTaskModel(pi, ctx);
      }

      return {
        content: [{ type: "text", text: `Goal created.\n${formatGoalSnapshot(goal)}` }],
        details: goalSnapshot(goal),
      };
    },
  });

  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Inspect the current goal status, objective, budget, and usage.",
    promptSnippet: "Inspect active goal state before deciding the next step",
    promptGuidelines: [
      "Use get_goal when a goal may already be active or when you need current budget/status context.",
    ],
    parameters: Type.Object({}),
    async execute() {
      if (!goal) {
        return {
          content: [{ type: "text", text: "No active goal." }],
          details: { status: "none" },
        };
      }

      return {
        content: [{ type: "text", text: formatGoalSnapshot(goal) }],
        details: goalSnapshot(goal),
      };
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: "Mark the active goal complete after the objective is genuinely achieved.",
    promptSnippet: "Mark the goal complete only after verification or a clearly finished deliverable",
    promptGuidelines: [
      "Use update_goal with status=complete only when the objective is genuinely achieved.",
      "If the goal has a token budget, report that token usage is unavailable in pi-goal unless pi exposes it.",
    ],
    parameters: Type.Object({
      status: Type.String({ description: "Only 'complete' is supported." }),
      summary: Type.Optional(Type.String({ description: "Short summary of what was completed." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.status !== "complete") {
        return {
          content: [{ type: "text", text: "update_goal only supports status=complete." }],
          details: { ok: false, reason: "unsupported_status" },
        };
      }
      if (!isActiveGoal(goal)) {
        return {
          content: [{ type: "text", text: "No active goal to complete." }],
          details: { ok: false, reason: "no_active_goal" },
        };
      }

      const completed = await markGoalComplete(pi, ctx, params.summary);
      return {
        content: [{ type: "text", text: "goal complete" }],
        details: { ok: true, ...goalSnapshot(completed!) },
      };
    },
  });

  // ── run_verify tool ───────────────────────────────────────────────────
  // The LLM can call this to run a verification command (e.g., pytest).
  // The raw output is stored in details; content stays terse to avoid noisy UI.

  pi.registerTool({
    name: "run_verify",
    label: "Run Verify",
    description:
      "Run a shell command to verify goal completion. Use this when you believe the goal may be done — " +
      "the exit code and stripped output are stored as structured details.",
    promptSnippet: "Run verification commands to confirm goal completion",
    promptGuidelines: [
      "Use run_verify when you believe the goal may be complete — run a command (e.g., pytest, npm test) and use the structured result to decide whether to continue.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run (e.g., 'pytest tests/')" }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await execVerifyCmd(params.command, ctx.cwd);
      const output = stripAnsi((result.stdout + "\n" + result.stderr).trim());
      const passed = result.code === 0;
      return {
        content: [
          {
            type: "text",
            text: passed
              ? "verification passed"
              : `verification failed with exit code ${result.code ?? "unknown"}`,
          },
        ],
        details: { exitCode: result.code, passed, output },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreGoal(ctx);
    if (goal) {
      log("session_start: restored goal —", goal.status, goal.text);
      ctx.ui.notify(`◎ Restored goal (${goal.status}): ${goal.text}`, "info");
    } else {
      log("session_start: no goal to restore");
    }

    if (goal && goal.status === "active") {
      startGoalActiveFooter(ctx);
      showGoalWidget(ctx, getObjective(goal));
    } else if (goal && goal.status === "paused") {
      setPausedStatus(ctx);
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (config.autoContinue && goal?.status === "active") {
      attachGoalAbortHandler(pi, ctx);
    }
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    const additions: string[] = [];

    if (isActiveGoal(goal)) {
      additions.push(
        "A durable /goal is active. Use get_goal to inspect it when needed. " +
        "When the objective is genuinely achieved, call update_goal with status=complete and a short summary. " +
        "Do not mark the goal complete while required work or verification remains. " +
        "Do not emit literal <think> tags in assistant text."
      );
    }

    if (pendingPlanReview) {
      additions.push(
        "When describing your approach, structure your response with clear markdown sections: ## Steps, ## Files to modify. Use concise numbered steps and file lists. Keep every section brief."
      );
    }

    if (additions.length === 0) return;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + additions.join("\n\n"),
    };
  });

  pi.on("message_end", async (event, ctx) => {
    if (!pendingPlanReview) return;
    if (event.message.role !== "assistant") return;

    const textContent = event.message.content
      ?.filter((c: any) => c.type === "text")
      ?.map((c: any) => c.text)
      ?.join("") ?? "";

    pendingPlanText = textContent;
    planLog("captured", textContent.length, "chars —", textContent.slice(0, 100));
    // Show plan widget immediately when text is available
    if (textContent) {
      showGoalWidget(ctx, getObjective(goal!), textContent);
    }
  });

  pi.on("tool_call", async (_event, ctx) => {
    if (!pendingPlanReview) return;

    planLog("tool_call: keeping active-goal widget (text length =", pendingPlanText.length, ")");
    pendingPlanReview = false;
    pendingPlanText = "";
  });

  pi.on("session_shutdown", async () => {
    detachAbortHandler();
    stopFooterTimer();
  });

  pi.on("agent_end", async (event, ctx) => {
    detachAbortHandler();

    // Show plan overlay if still pending (no tools were called this turn)
    if (pendingPlanReview) {
      planLog("agent_end: showing widget fallback (text length =", pendingPlanText.length, ")");
      pendingPlanReview = false;
      if (pendingPlanText) {
        showGoalWidget(ctx, goal ? getObjective(goal) : "Goal", pendingPlanText);
      }
      pendingPlanText = "";
    } else {
      pendingPlanText = "";
    }

    if (!goal || goal.status !== "active") {
      log("agent_end: skipped (no active goal)");
      return;
    }

    if (!config.autoContinue) {
      log("agent_end: skipped (autoContinue disabled)");
      return;
    }

    log("agent_end: evaluating turn", goal.turnsUsed + 1, "of", goal.maxTurns);

    const lastResponse = getLastAssistantText(event.messages);
    if (!lastResponse) {
      log("agent_end: no assistant text found in messages — stopping loop");
      return;
    }

    log("agent_end: response preview =", lastResponse.slice(0, 200));

    const verdict = await judge(goal.text, lastResponse, ctx);
    log("agent_end: verdict =", verdict);

    if (verdict.done) {
      const turnsUsed = goal.turnsUsed + 1; // +1 for the current/final turn
      await markGoalComplete(pi, ctx);
      ctx.ui.notify(
        `◎ Goal achieved in ${elapsed(goal.createdAt)} (${turnsUsed}/${goal.maxTurns} turns): ${verdict.reason}`,
        "success"
      );
      log("agent_end: goal marked done —", verdict.reason);
      return;
    }

    if (verdict.pauseForSafety) {
      goal.status = "paused";
      persistGoal(pi, goal);
      ctx.ui.notify(`⏸ ${verdict.reason}. /goal resume to retry.`, "warning");
      setPausedStatus(ctx);
      await restoreModelAndThinking(pi, ctx);
      log("agent_end: paused for judge safety fallback —", verdict.reason);
      return;
    }

    goal.turnsUsed++;
    persistGoal(pi, goal);

    if (goal.turnsUsed >= goal.maxTurns) {
      goal.status = "paused";
      persistGoal(pi, goal);
      ctx.ui.notify(
        `⏸ Goal paused — ${goal.turnsUsed}/${goal.maxTurns} turns used. /goal resume to continue.`,
        "info"
      );
      setPausedStatus(ctx);
      await restoreModelAndThinking(pi, ctx);
      log("agent_end: max turns reached — paused");
      return;
    }

    ctx.ui.notify(`↻ Continuing (${goal.turnsUsed}/${goal.maxTurns}): ${verdict.reason}`, "info");
    log("agent_end: continuing —", verdict.reason);
    pi.sendUserMessage(buildContinuationMessage(goal.text, lastResponse, verdict.reason));
  });
}
