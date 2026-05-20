# Changelog

## Unreleased

- Add Codex-style lifecycle tools: `create_goal`, `get_goal`, and `update_goal`
- Change default behavior to explicit completion via `update_goal(status=complete)`
- Add `autoContinue` config / `PI_GOAL_AUTO_CONTINUE`; the judge loop is now opt-in legacy behavior
- Add debug logging via `PI_GOAL_DEBUG` and `PI_GOAL_LOG` env vars
- Integrate `pi-ai` completion for judge evaluation
- Set default judge model to `canopy-wave/minimax/minimax-m2.5`
- Add `showPlan` config / `PI_GOAL_SHOW_PLAN` env var — preview LLM's inferred plan
  in a compact dimmed widget above the input bar
- Keep the compact goal widget visible for the full active-goal lifecycle
- Clear the compact goal widget immediately after `update_goal(status=complete)`
- Strip literal `<think>` blocks from goal widget summaries when providers return them as text
- Add quiet `run_verify` tool for shell-command completion evidence
- Smarter continuation: each follow-up turn includes a summary of the previous turn's
  work and the judge's reason, instead of a generic "continuing" message

## 1.0.0 (2026-05-18)

- Initial release
- `/goal <text>` — set a standing goal and kick off the first turn
- `/goal status` — show current goal, status, and turns used
- `/goal pause` — pause the auto-continuation loop
- `/goal resume` — resume the loop (resets turn counter)
- `/goal clear` — drop the goal entirely
- Judge loop evaluates completion after every agent turn
- Configurable max turns (default 20), separate judge/task models
- State persistence via session custom entries
- Task model switching with automatic restore
