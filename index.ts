// pi-goal — Standing goal with judge loop for pi
// Inspired by Hermes Agent's /goal and Codex CLI's goal feature.
//
// Config file: config.json (same directory as this extension)
//   maxTurns       — budget before auto-pause (default 20)
//   judgeModel     — provider/model-id for the judge (default: current model)
//   taskModel      — provider/model-id for the task execution (default: current model)
//   taskThinking   — thinking level for task execution (default: unchanged)
//
// Env var fallback (overrides config.json):
//   PI_GOAL_MAX_TURNS, PI_GOAL_JUDGE_MODEL
//
// Debug:
//   PI_GOAL_DEBUG=true       — Enable debug log to /tmp/pi-goal.log (or PI_GOAL_LOG=path)
//
// Usage:
//   /goal <text>      — Set a standing goal and kick off the first turn
//   /goal status      — Show current goal, status, and turns used
//   /goal pause       — Pause the auto-continuation loop
//   /goal resume      — Resume the loop (resets turn counter to zero)
//   /goal clear       — Drop the goal entirely

import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Model, Api } from "@earendil-works/pi-coding-agent";
import { readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// ── Config loader ─────────────────────────────────────────────────────

interface GoalConfig {
  maxTurns: number;
  judgeModel: string;
  taskModel: string;
  taskThinking: string;
}

function loadConfig(): GoalConfig {
  const defaults: GoalConfig = { maxTurns: 20, judgeModel: "", taskModel: "", taskThinking: "" };

  try {
    const extDir = dirname(fileURLToPath(import.meta.url));
    const configPath = join(extDir, "config.json");
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    return {
      maxTurns: raw.maxTurns ?? defaults.maxTurns,
      judgeModel: raw.judgeModel ?? defaults.judgeModel,
      taskModel: raw.taskModel ?? defaults.taskModel,
      taskThinking: raw.taskThinking ?? defaults.taskThinking,
    };
  } catch {
    return defaults;
  }
}

function resolveConfig(): GoalConfig {
  const file = loadConfig();
  return {
    maxTurns: parseInt(process.env.PI_GOAL_MAX_TURNS || String(file.maxTurns), 10),
    judgeModel: process.env.PI_GOAL_JUDGE_MODEL || file.judgeModel,
    taskModel: process.env.PI_GOAL_TASK_MODEL || file.taskModel,
    taskThinking: process.env.PI_GOAL_TASK_THINKING || file.taskThinking,
  };
}

const config = resolveConfig();

// ── Types ─────────────────────────────────────────────────────────────

interface GoalState {
  text: string;
  status: "active" | "paused" | "done";
  turnsUsed: number;
  maxTurns: number;
  createdAt: number;
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
  return `◎ /goal done`;
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

// ── Command handlers ─────────────────────────────────────────────────

async function cmdStatus(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (!goal) {
    ctx.ui.notify("No active goal. Use /goal <text> to set one.", "info");
    return;
  }
  ctx.ui.notify(formatStatus(goal), goal.status === "done" ? "success" : "info");
}

async function cmdSet(text: string, pi: ExtensionAPI, ctx: ExtensionContext) {
  log("cmd: set —", text);
  if (goal?.status === "active") {
    ctx.ui.notify("A goal is already active. /goal pause or /goal clear first.", "warning");
    return;
  }

  // Restore any leftover model state from a previous goal
  if (previousModel) {
    await restoreModelAndThinking(pi, ctx);
  }

  goal = {
    text,
    status: "active",
    turnsUsed: 0,
    maxTurns: config.maxTurns,
    createdAt: Date.now(),
  };

  persistGoal(pi, goal);
  ctx.ui.notify(`⊙ Goal set (${goal.maxTurns}-turn budget): ${text}`, "info");

  startGoalActiveFooter(ctx);

  // Switch to task model if configured
  if (config.taskModel) {
    await switchToTaskModel(pi, ctx);
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
  if (goal.status === "done") {
    ctx.ui.notify("Goal is done. /goal clear to start a new one.", "info");
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
  await restoreModelAndThinking(pi, ctx);
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
      } else {
        await cmdSet(args, pi, ctx);
      }
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
    } else if (goal && goal.status === "paused") {
      setPausedStatus(ctx);
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (goal?.status === "active") {
      attachGoalAbortHandler(pi, ctx);
    }
  });

  pi.on("session_shutdown", async () => {
    detachAbortHandler();
    stopFooterTimer();
  });

  pi.on("agent_end", async (event, ctx) => {
    detachAbortHandler();

    if (!goal || goal.status !== "active") {
      log("agent_end: skipped (no active goal)");
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
      goal.status = "done";
      persistGoal(pi, goal);
      const turnsUsed = goal.turnsUsed + 1; // +1 for the current/final turn
      ctx.ui.notify(
        `◎ Goal achieved in ${elapsed(goal.createdAt)} (${turnsUsed}/${goal.maxTurns} turns): ${verdict.reason}`,
        "success"
      );
      clearGoalFooter(ctx);
      await restoreModelAndThinking(pi, ctx);
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
    pi.sendUserMessage(`[Continuing toward your standing goal: ${goal.text}]`);
  });
}
