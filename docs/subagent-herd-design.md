# Design: herd subagents (next version)

> Status: **future**, not in v1. Moved out of `docs/subagent-design.md`, which covers v1 (one-shot
> `task` children only). Everything here builds on that doc: same process model, envelope, inbox,
> result storage, lifecycle, display and lookup. This doc only lists what herds add or change.

## What a herd is

A resident child: spawned once, then given several tasks over its life, one result per task. It
stays alive between tasks until it is killed or the leader session ends.

| Kind | Spawned by | Ends when | After end |
|---|---|---|---|
| `herd` (resident) | leader or user | killed by leader or user, or the session ends | reaped |

- Leader: `subagent_spawn({ scenario, kind: "herd", project? })`, no task.
- User: `/agent herd <scenario>`.
- Next task: tool `subagent_send({ id, task })` (and a user equivalent, open).

## States

```
spawning → idle ⇄ busy
any → failed | killed | aborted → reaped
```

- `busy` → `idle`: the child's RPC stream emits `agent_settled` after the task's result.
- A herd never reaches `done`; it ends only by kill, failure or session end.

## IDs

- Same `a<N>` sequence as tasks.
- Each result gets a per-task suffix: `a4.1`, `a4.2`, … in task order (`resultId` in records and
  `details`). Lookup (`/agent`, `subagent_get`, `subagent_grep`) accepts `a4` (all of the herd's
  results) and `a4.2` (one).
- Suffixes continue after a resume.

## Transport

- `task` envelope: RPC `prompt` when the herd is idle, `follow_up` when busy.
- `control: reset`: RPC `new_session` (clear the herd's context), herd-only.

## Start and task records

- `subagent-start` with `kind: "herd"` and no task.
- One `pi.appendEntry("subagent-task", { resultId, task })` per task sent. Resume reconciliation
  uses these: a task entry without a matching result gets `aborted`.

## Lifecycle differences

- Session end: only the herd's **current** task (if busy) gets an `aborted` result; an idle herd
  just ends, with no result.
- Herds do not survive a leader restart; their session files are kept.
- Restarting a herd result (`a4.2`) spawns a fresh herd and sends it that task.

## Display

- Progress line for the idle state: `idle · waiting for task`.
- Widget example: `○ a4 triage   idle  4m02s  idle · waiting for task`; footer
  `agents: 1 busy · 1 idle`.
- `/agent` page header shows the kind; a herd page lists its results (`a4.1`, `a4.2`, …) and, if
  live, its state and progress.

## Tests

- Several tasks → suffixed results in order.
- Session end while busy: only the current task gets `aborted`; idle herd: none.
- Suffix numbering continues after a resume.
- `follow_up` to a busy herd is queued and answered with the next suffix.

## Open questions

- Herd context growth: compaction vs `reset`.
- Herd revival on resume from the kept session files.
- Per-kind limits (max concurrent herds).
- Whether the user can send a herd tasks directly, or only through the leader.
