# Changelog

## Unreleased

- Add debug logging via `PI_GOAL_DEBUG` and `PI_GOAL_LOG` env vars
- Integrate `pi-ai` completion for judge evaluation
- Set default judge model to `canopy-wave/minimax/minimax-m2.5`

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
