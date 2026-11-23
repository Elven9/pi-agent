# Subagents

The subagent extension lets a pi session (the leader) hand self-contained tasks to subagents:
separate pi agents, each in its own process (`pi --mode rpc [--scenario <name>]`). With a scenario a
subagent gets that scenario's prompt and tools; without one it is a general pi agent (pi's own
prompt, all built-in tools and pi's docs), shown as `general`.
A subagent works in the background and reports once; its result lands in the leader's context.

## Tools (leader)

| Tool | Does |
|---|---|
| `subagent_spawn(task, scenario?, project?, model?, thinking?)` | Starts a subagent and returns its ID (`a3`) at once. The task must say everything: a subagent cannot ask questions. `model`: exact `provider/id` of a model with credentials (default: the leader's); `thinking`: `off` … `max` (default: the leader's, clamped to the model). |
| `subagent_kill(id)` | Kills a running subagent; it ends with a `killed` result. |
| `subagent_restart(id)` | Runs a finished subagent's task again in a fresh subagent (new ID, same scenario, task, project, model and thinking level). |
| `subagent_get(ids, lines?, maxChars?)` | Shows results by ID: task, summary and structured detail, numbered lines. |
| `subagent_grep(pattern, ids?, context?)` | Finds results by regex, newest first. |

- Results arrive by themselves as `[subagent a3] <scenario> · <status> · <duration>` messages and
  start a new turn when the leader is idle. Do not poll or wait for them.
- Statuses: `ok` and `error` from the subagent; `failed` (crashed or stopped without a result),
  `killed` and `aborted` (the leader session ended) written by the leader. The header adds
  `· restart of a2` and `· started by user` when they apply; a subagent the user starts is announced
  with a `[subagent a5] started by user` message. A result that did not
  finish by itself also repeats the task, for `subagent_restart`.
- A subagent runs with the model it was given (else the leader's), its scenario's prompt and tools (pi's own plus
  `codemode` without a scenario), and only one extra tool: `send_to_leader`. Subagents cannot start subagents.
- Subagents are codemode-only whatever the user's `codemode.mode` setting: their other tools are
  hidden from the model and called from codemode scripts; `send_to_leader` is called directly.

## For the user

- A widget above the editor shows each running subagent's state and what it is doing (the
  `// intent:` line of its codemode scripts, else the tool and its input); the end of the footer's
  cwd line shows a count (`🤖 2 busy`).
- A result row shows the task (cut with `...` when long); `/agent a3` (or a click on the row in
  fullscreen mode) opens the whole result.
  Display only: never in the model's context or the session.
- `/agent` pages through all subagents (newest first), `/agent a3` shows one, `/agent grep <regex>`
  the matching results; `x` in the panel kills a running one. `/agent kill a3` and
  `/agent restart a3` do the same without the panel.

## Lifecycle

- Ending the session (`/exit`, `/new`, `/resume`, `/fork`, `/reload`) stops every subagent. `/new`
  and `/resume` ask first. Unfinished tasks get an `aborted` result in that session, written when
  it is next opened (also after a crash).
- Subagent sessions are saved in a `subagents/` folder next to the leader's session file.
