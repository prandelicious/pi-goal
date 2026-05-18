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
// Usage:
//   /goal <text>      — Set a standing goal and kick off the first turn
//   /goal status      — Show current goal, status, and turns used
//   /goal pause       — Pause the auto-continuation loop
//   /goal resume      — Resume the loop (resets turn counter to zero)
//   /goal clear       — Drop the goal entirely

import type { ExtensionAPI, ExtensionContext, Model, Api } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY_TYPE = "pi-goal";

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
}

interface ClearedSentinel {
  status: "cleared";
  clearedAt: number;
}

// ── Runtime state (per-extension-instance, restored from session) ─────

let goal: GoalState | null = null;
let previousModel: Model<Api> | undefined = undefined;
let previousThinking: string | undefined = undefined;

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
    return { done: false, reason: "No judge model available, continuing" };
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    return { done: false, reason: `No auth for judge model (${auth.error}), continuing` };
  }

  const prompt = `You are a goal-completion judge. Reply with strict JSON only.

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
    const baseUrl = model.baseUrl;
    const isAnthropic = model.api === "anthropic-messages";

    const url = isAnthropic
      ? `${baseUrl}/v1/messages`
      : `${baseUrl}/chat/completions`;

    const body = isAnthropic
      ? JSON.stringify({
          model: model.id,
          max_tokens: 200,
          system: "You are a goal-completion judge. Reply with strict JSON only.",
          messages: [{ role: "user", content: prompt }],
        })
      : JSON.stringify({
          model: model.id,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 200,
          temperature: 0,
        });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...auth.headers,
    };

    if (auth.apiKey && !headers["Authorization"]) {
      headers["Authorization"] = `Bearer ${auth.apiKey}`;
    }
    if (isAnthropic && auth.apiKey && !headers["x-api-key"]) {
      headers["x-api-key"] = auth.apiKey;
      headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01";
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: ctx.signal,
    });

    if (!res.ok) {
      return { done: false, reason: `Judge API error ${res.status}, continuing` };
    }

    const data: any = await res.json();
    const text =
      data.choices?.[0]?.message?.content ??
      data.content?.find((c: any) => c.type === "text")?.text ??
      "";

    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) {
      return { done: false, reason: "Judge returned non-JSON, continuing" };
    }

    const verdict = JSON.parse(match[0]);
    return {
      done: Boolean(verdict.done),
      reason: String(verdict.reason || "Continuing toward goal"),
    };
  } catch (err: any) {
    return { done: false, reason: `Judge error (${err.message}), continuing` };
  }
}

// ── UI helpers ─────────────────────────────────────────────────────────

const WIDGET_KEY = "pi-goal-widget";

function goalEmoji(status: GoalState["status"]): string {
  return status === "active" ? "⊙" : status === "paused" ? "⏸" : "✓";
}

function formatStatus(g: GoalState): string {
  return `${goalEmoji(g.status)} Goal (${g.turnsUsed}/${g.maxTurns}): ${g.text}`;
}

function updateHud(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  const theme = ctx.ui.theme;

  if (!goal) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }

  const emoji = goalEmoji(goal.status);
  const line = `${emoji} Goal (${goal.turnsUsed}/${goal.maxTurns}): ${goal.text}`;

  if (goal.status === "active") {
    ctx.ui.setWidget(WIDGET_KEY, [theme.fg("accent", line)]);
  } else if (goal.status === "paused" || goal.status === "done") {
    ctx.ui.setWidget(WIDGET_KEY, [theme.fg("dim", line)]);
  }
}

function clearHud(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, undefined);
}

// ── Command handlers ─────────────────────────────────────────────────

async function cmdStatus(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (!goal) {
    ctx.ui.notify("No active goal. Use /goal <text> to set one.", "info");
    return;
  }
  ctx.ui.notify(formatStatus(goal), goal.status === "done" ? "success" : "info");
  updateHud(pi, ctx);
}

async function cmdSet(text: string, pi: ExtensionAPI, ctx: ExtensionContext) {
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

  updateHud(pi, ctx);

  // Switch to task model if configured
  if (config.taskModel) {
    await switchToTaskModel(pi, ctx);
  }

  // Kick off the first turn immediately
  pi.sendUserMessage(text);
}

async function cmdPause(pi: ExtensionAPI, ctx: ExtensionContext) {
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
  updateHud(pi, ctx);
  await restoreModelAndThinking(pi, ctx);
}

async function cmdResume(pi: ExtensionAPI, ctx: ExtensionContext) {
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

  updateHud(pi, ctx);

  if (config.taskModel) {
    await switchToTaskModel(pi, ctx);
  }

  pi.sendUserMessage(`[Continuing toward your standing goal: ${goal.text}]`);
}

async function cmdClear(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (!goal) {
    ctx.ui.notify("No goal to clear.", "info");
    return;
  }
  goal = null;
  pi.appendEntry(ENTRY_TYPE, { status: "cleared", clearedAt: Date.now() } as ClearedSentinel);
  ctx.ui.notify("✗ Goal cleared.", "info");
  clearHud(ctx);
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
      const emoji = goalEmoji(goal.status);
      ctx.ui.notify(`${emoji} Restored goal (${goal.status}): ${goal.text}`, "info");
      updateHud(pi, ctx);
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!goal || goal.status !== "active") return;

    const lastResponse = getLastAssistantText(event.messages);
    if (!lastResponse) return;

    const verdict = await judge(goal.text, lastResponse, ctx);

    if (verdict.done) {
      goal.status = "done";
      persistGoal(pi, goal);
      ctx.ui.notify(`✓ Goal achieved: ${verdict.reason}`, "success");
      updateHud(pi, ctx);
      await restoreModelAndThinking(pi, ctx);
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
      updateHud(pi, ctx);
      await restoreModelAndThinking(pi, ctx);
      return;
    }

    updateHud(pi, ctx);
    ctx.ui.notify(`↻ Continuing (${goal.turnsUsed}/${goal.maxTurns}): ${verdict.reason}`, "info");
    pi.sendUserMessage(`[Continuing toward your standing goal: ${goal.text}]`);
  });
}
