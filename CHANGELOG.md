# Changelog

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
