# pi-goal

Standing goal with judge loop for [pi](https://pi.dev). Inspired by Hermes
Agent's `/goal` and Codex CLI's goal feature.

Set a goal and pi keeps working toward it — turn after turn — until it's
done, you pause it, or the budget runs out. A lightweight judge evaluates
completion after every agent response.

```
/goal Fix every failing test in tests/ and make sure pytest passes

  ⊙ Goal set (20-turn budget): Fix every failing test in tests/...

  Agent: [works on tests...]
  ↻ Continuing (1/20): 3 tests still failing, 12 fixed.

  Agent: [continues working...]
  ↻ Continuing (2/20): 1 test remaining.

  Agent: [fixes last test, runs pytest]
  ✓ Goal achieved: All tests pass and pytest returns 0.
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
| `/goal <text>` | Set a standing goal and kick off the first turn |
| `/goal` or `/goal status` | Show current goal, status, and turns used |
| `/goal pause` | Stop the auto-continuation loop |
| `/goal resume` | Resume the loop (resets turn counter to zero) |
| `/goal clear` | Drop the goal entirely |

## Configuration

**Zero config required.** The judge uses a dedicated lightweight model by default.

Config file: `config.json` (next to `index.ts`)

| Field | Default | Description |
|---|---|---|
| `maxTurns` | `20` | Continuation turns before auto-pause |
| `judgeModel` | `canopy-wave/minimax/minimax-m2.5` | Provider/model for the judge |
| `taskModel` | (current model) | Provider/model for task execution |
| `taskThinking` | (unchanged) | Thinking level for task execution |

Env vars override config.json:

| Variable | Overrides |
|---|---|
| `PI_GOAL_MAX_TURNS` | `maxTurns` |
| `PI_GOAL_JUDGE_MODEL` | `judgeModel` |
| `PI_GOAL_TASK_MODEL` | `taskModel` |
| `PI_GOAL_TASK_THINKING` | `taskThinking` |

### Debug logging

Set `PI_GOAL_DEBUG=true` to write structured logs to `/tmp/pi-goal.log` (or set a custom path with `PI_GOAL_LOG`).

### When you might want a separate judge model

If your primary model is expensive (e.g. Claude Opus), set a cheap model
for the judge:

```bash
export PI_GOAL_JUDGE_MODEL="openai/gpt-4o-mini"
```

The model must be registered in pi (visible via `pi --list-models` or
`/model`). The default judge model is a fast, cost-effective option — override it if you prefer a different one.

## How it works

1. **`/goal <text>`** saves the goal and sends it as a user message
2. **`agent_end`** event fires after each agent response
3. **Judge** evaluates the latest assistant output against the goal
4. If **done** → goal marked complete, loop stops
5. If **not done and under budget** → continuation prompt injected, agent runs again
6. If **over budget** → auto-pause

### User preemption

Any real message you send while a goal is active takes priority. The judge
runs again after your turn — if your message happens to complete the goal,
the judge catches it and stops.

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
