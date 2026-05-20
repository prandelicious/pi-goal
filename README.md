# pi-goal

Codex-style standing goal state for [pi](https://pi.dev).

Set a goal and pi keeps durable objective state available to the agent through
`create_goal`, `get_goal`, and `update_goal`. The agent marks the goal complete
explicitly when the objective is genuinely achieved.

## When to use `/goal`

Use a goal when the task has a **clear finish line** but the **path to that
finish line is uncertain**.

**Good candidates:**
- Performance optimization
- Flaky test investigation
- Dependency migrations
- Bug hunts requiring reproduction
- Multi-step refactors
- Benchmark-driven tuning
- Research tasks requiring a final artifact

**Use a normal prompt** for one-off edits, simple questions, or anything
you could describe in a single turn.

```
/goal Fix every failing test in tests/ and make sure pytest passes

  ⊙ Goal set (explicit completion): Fix every failing test in tests/...

  Agent: [works on tests...]
  Agent: [runs verification...]
  Agent tool: update_goal({ "status": "complete" })
```

## Install

```bash
# From a local path
pi install ./path/to/pi-goal

# Or symlink into global extensions
ln -s "$PWD" ~/.pi/agent/extensions/pi-goal

# Then reload
/reload
```

## Commands

| Command | Effect |
|---|---|
| `/goal <text>` | Set a standing goal and kick off the first turn if no goal is active |
| `/goal` or `/goal status` | Show current goal, status, budget, and usage |
| `/goal pause` | Pause the legacy auto-continuation loop |
| `/goal resume` | Resume the legacy loop (resets turn counter to zero) |
| `/goal clear` | Drop the goal entirely |
| `/goal dismiss` | Hide the goal widget |

## Model tools

| Tool | Effect |
|---|---|
| `create_goal` | Create a durable active goal with an optional token budget |
| `get_goal` | Return status, objective, budget, and usage fields |
| `update_goal` | Mark the active goal complete with `status=complete` |
| `run_verify` | Run a quiet shell verification command when the agent needs completion evidence |

## Configuration

**Zero config required.** By default, pi-goal behaves like Codex: goal state is
explicit and completion is marked through `update_goal`.

Config file: `~/.pi/agent/pi-goal.json`

| Field | Default | Description |
|---|---|---|
| `autoContinue` | `false` | Enable the legacy judge loop that injects follow-up turns |
| `maxTurns` | `20` | Legacy continuation turns before auto-pause |
| `judgeModel` | `canopy-wave/minimax/minimax-m2.5` | Provider/model for the legacy judge |
| `taskModel` | (current model) | Provider/model for task execution |
| `taskThinking` | (unchanged) | Thinking level for task execution |
| `showPlan` | `false` | Add LLM's inferred plan as the second line of the compact goal widget |

Env vars override pi-goal.json:

| Variable | Overrides |
|---|---|
| `PI_GOAL_AUTO_CONTINUE` | `autoContinue` |
| `PI_GOAL_MAX_TURNS` | `maxTurns` |
| `PI_GOAL_JUDGE_MODEL` | `judgeModel` |
| `PI_GOAL_TASK_MODEL` | `taskModel` |
| `PI_GOAL_TASK_THINKING` | `taskThinking` |
| `PI_GOAL_SHOW_PLAN` | `showPlan` |

### Legacy auto-continuation

Set `autoContinue` or `PI_GOAL_AUTO_CONTINUE=true` to re-enable the older judge
loop. In that mode, the continuation message includes a summary of what the
agent did in the previous turn and the judge's reason for continuing.

```
[Continuing toward goal: Fix failing tests in tests/]
Previous turn: I ran pytest and found 3 failing tests — test_auth,
test_api, and test_db. I fixed test_auth by correcting the mock setup.
Still need to fix test_api and test_db.
Status: 2 of 5 tests still failing, continuing.
```

### Verification via `run_verify` tool

The extension registers a `run_verify` tool the LLM can call during any turn.
The LLM decides what verification makes sense for the specific goal — it
passes a shell command (e.g., `pytest tests/`). Raw successful output is kept in
structured tool details; the visible tool result is only `verification passed`.

This is more flexible than a static config command: the LLM chooses what to
verify, when to verify it, and how to interpret the results.

```
Agent: Let me verify the fix.
  ▶ run_verify({ command: "pytest tests/" })
Agent: All tests pass. Goal is complete.
Agent tool: update_goal({ "status": "complete", "summary": "All tests pass." })
```

### Goal Widget

While a goal is active, pi-goal displays a compact dimmed widget directly above
the input bar. The widget intentionally avoids borders and tall cards so terminal
resize redraws stay simple.

```
● /goal active · Fix failing tests in tests/
```

When `showPlan` is enabled (or `PI_GOAL_SHOW_PLAN=true`), pi-goal captures the
LLM's initial response to your goal and adds a second compact line:

```
● /goal active · Fix failing tests in tests/
  ## Steps 1. Read failing tests 2. Fix each failing test 3. Run pytest
```

When the agent calls
`update_goal({ "status": "complete", "summary": "..." })`, pi-goal clears the
widget immediately. `/goal clear` also clears both goal state and the widget.

### Debug logging

Set `PI_GOAL_DEBUG=true` to write structured logs to `/tmp/pi-goal.log` (or set a custom path with `PI_GOAL_LOG`).

### When you might want a separate judge model

If `autoContinue` is enabled and your primary model is expensive, set a cheap
model for the legacy judge:

```bash
export PI_GOAL_JUDGE_MODEL="openai/gpt-4o-mini"
```

The model must be registered in pi (visible via `pi --list-models` or
`/model`).

## How it works

1. **`/goal <text>`** saves the goal if none is active and sends it as a user message
2. The extension exposes **`create_goal`**, **`get_goal`**, and **`update_goal`** to the model
3. **`get_goal`** returns status, objective, budget, and usage fields
4. The agent works normally across turns
5. When the objective is genuinely achieved, the agent calls **`update_goal({ status: "complete" })`**
6. If `autoContinue` is enabled, the old `agent_end` judge loop can still inject follow-up turns

### User preemption

Any real message you send while a goal is active takes priority. The active
goal remains durable until the agent marks it complete or you clear it.

### Persistence

Goal state is stored in the session file via `pi.appendEntry()`. Survives
`/resume`, laptop close, and pi restarts.

## Development

```bash
git clone <repo-url>
cd pi-goal

# Test locally
pi -e ./index.ts

# Or symlink for persistent use
ln -s "$PWD" ~/.pi/agent/extensions/pi-goal
```

### Peer dependencies

- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`

## License

MIT
