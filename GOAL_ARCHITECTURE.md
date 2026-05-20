# pi-goal Architecture

## Current Codex-Style Flow

```
User: /goal fix failing tests
        │
        ▼
   ┌──────────────┐
   │   cmdSet()   │  ◄── Creates durable goal only when none is active
   └──────┬───────┘
          │
          ├──► create_goal / get_goal / update_goal exposed as model tools
          │
          ├──► before_agent_start reminds model to inspect and complete goal explicitly
          │
          └──► pi.sendUserMessage(text) starts normal work

Agent works normally across turns.
When the objective is genuinely achieved:

   ┌───────────────────────────────────────────────┐
   │ update_goal({ status: "complete" })           │
   │ persists completion, clears footer, reports   │
   │ token budget with pi runtime usage unavailable│
   └───────────────────────────────────────────────┘
```

The older `agent_end -> judge -> sendUserMessage()` loop still exists, but only
runs when `autoContinue` or `PI_GOAL_AUTO_CONTINUE=true` is enabled.

## Legacy Auto-Continue Lifespan

```
 User: /goal recite the top 5 Shakespeare lines
         │
         ▼
    ┌──────────────┐
    │   cmdSet()   │  ◄── Sets goal state, persists, arms plan review
    │              │       Calls pi.sendUserMessage() → agent starts
    └──────┬───────┘
           │
           ▼  ┌─────────────────────────────────────────────────────┐
 before_agent │  If plan review armed: inject system prompt asking │
    _start    │  for ## Steps / ## Files to modify sections         │
              └─────────────────────────────────────────────────────┘
           │
           ▼
    ┌──────────────────────────────────────────────────────────────┐
    │              Agent Turn (LLM runs)                           │
    │                                                              │
    │  ┌──────────────┐    ┌──────────────┐    ┌────────────────┐ │
    │  │ Text streams │    │ Tool calls   │    │ Response done  │ │
    │  │  to TUI      │    │  execute     │    │  (message_end) │ │
    │  └──────┬───────┘    └──────┬───────┘    └───────┬────────┘ │
    │         │                  │                      │          │
    │         │                  │  SHOW PLAN           │          │
    │         │                  │  (tool_call          │  SHOW    │
    │         │                  │   clears             │  PLAN    │
    │         │                  │   widget)            │  (agent  │
    │         │                  │                      │  _end    │
    │         │                  │                      │  fallback│
    │         ▼                  ▼                      ▼          │
    └──────────────────────────────────────────────────────────────┘
           │
           ▼
    ┌──────────────┐
    │   agent_end   │  ◄── Judge evaluates verdict
    └──────┬───────┘        If done: mark complete
           │                If needs_work: send continuation
           ▼
    ┌─────────────────────────────────────────────────────┐
    │  Judge: "The goal was to recite top 5 Shakespeare   │
    │  lines. The assistant listed lines 1-5 clearly.     │
    │  → done: true, reason: 'All 5 lines provided.'"     │
    └─────────────────────────────────────────────────────┘
           │
           ▼
    ┌──────────────┐
    │  Goal done!  │  ◄── Widget cleared, footer removed
    └──────────────┘
```

## Legacy Timing Problem

```
CURRENT BEHAVIOR:

  cmdSet() ────► pi.sendUserMessage() ──► LLM starts ──► Text streams to TUI
     │                                          │                  │
     │  Arms plan review                        │  Widget shown    │
     │  (sets flag)                             │  AFTER text is   │
     │                                          │  already visible │
     ▼                                          ▼                  ▼
  Widget empty                              Widget shows          User sees
  (nothing yet)                             the *answer*          the answer
                                          (not a plan)          in chat
```

## Legacy Event Order

```
pi.sendUserMessage(text)
  │
  ├──► before_agent_start   (inject ## Steps prompt)
  │
  ├──► LLM starts generating
  │      │
  │      ├── Text streams → TUI shows it in real-time
  │      │
  │      └── LLM finishes
  │             │
  │             ├──► message_end     ←── Widget set HERE (too late!)
  │             │
  │             ├──► tool_call       ←── Widget cleared (if tools called)
  │             │
  │             └──► agent_end       ←── Judge runs, continuation
  │
  └──► agent_end complete
```

## Legacy State Machine

```
                    ┌─────────────────┐
                    │   No goal       │
                    └────────┬────────┘
                             │ /goal <text>
                             ▼
                    ┌─────────────────┐
             ┌──────│   Active goal   │◄────── /goal resume ──────┐
             │      └────────┬────────┘                           │
             │               │                                    │
             │      ┌────────▼────────┐                           │
             │      │  Plan review    │  (if showPlan enabled)    │
             │      │  armed=true     │                           │
             │      └────────┬────────┘                           │
             │               │                                    │
             │      ┌────────▼────────┐                           │
             │      │ LLM generates   │──► message_end captures   │
             │      │ response        │    text + shows widget    │
             │      └────────┬────────┘                           │
             │               │                                    │
             │      ┌────────▼────────┐                           │
             │      │ Tool call(s)?   │                           │
             │      └────────┬────────┘                           │
             │         yes   │   no                               │
             │      ┌───────▼───────┐  ┌─────────────────────┐    │
             │      │ tool_call     │  │ agent_end fallback  │    │
             │      │ clears widget │  │ shows widget        │    │
             │      └───────┬───────┘  └──────────┬──────────┘    │
             │              │                     │               │
             │              ▼                     ▼               │
             │      ┌────────────────────────────────────┐        │
             │      │          agent_end                 │        │
             │      │  Judge evaluates ─► verdict        │        │
             │      └────────────────────────────────────┘        │
             │               │                                    │
             │      ┌────────┼──────────┬────────────┐           │
             │      ▼        ▼          ▼            ▼           │
             │  done=true  paused    maxTurns    needs work      │
             │      │        │          │            │           │
             │      ▼        ▼          ▼            ▼           │
             │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────────┐ │
             │  │ Done   │ │ Paused │ │ Paused │ │ Continue   │─┘
             │  └────────┘ └────────┘ └────────┘ │ send msg   │
             │                                    └────────────┘
             │
             ▼
    ┌─────────────────┐
    │  Goal done      │
    └─────────────────┘
```

## Legacy Flow With Widget

```
  cmdSet()
    │
    ├── Sets pendingPlanReview = true
    │
    ├── pi.sendUserMessage("recite top 5 Shakespeare lines")
    │
    │   ┌─ before_agent_start ──┐
    │   │ Injects ## Steps,     │
    │   │ ## Files to modify    │
    │   └───────────────────────┘
    │
    │   LLM starts generating
    │   │
    │   ├── Text streams: "1. To be or not to be..."
    │   │   │  User sees this streaming in real-time
    │   │   │
    │   ├── message_end fires
    │   │   │  Widget appears with the answer text!
    │   │   │  But user already saw it in chat...
    │   │   │
    │   └── agent_end fires
    │       │  Judge: "Goal achieved" ✓
    │       │  No continuation needed
    │
    └── Complete
```

## Key Insight

For **simple Q&A** (like "recite Shakespeare"), the plan = the answer. There's
no separate planning phase because the LLM just answers directly.

For **complex goals** (like "fix flaky tests"), the LLM naturally produces:
1. A text plan ("I'll read the tests, identify the issue, fix it, verify")
2. Then tool calls (read files, edit, run tests)

The widget helps in case #2 but is redundant in case #1.

## The Fix: Show Widget Before LLM Starts

```
  cmdSet()
    │
    ├── Sets pendingPlanReview = true
    ├── Shows widget: "◎ Generating plan..."
    │   └── User sees widget IMMEDIATELY
    │
    ├── pi.sendUserMessage(text)
    │
    ├── message_end captures text
    │   └── Updates widget with LLM's text
    │
    ├── tool_call clears widget
    │
    └── agent_end clears widget
```
