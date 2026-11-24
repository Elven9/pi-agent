# Design: scenario subagents

> Status: **v1 implemented** (`src/subagent/`, see "Implementation notes"). Herds: `docs/subagent-herd-design.md`.
> Based on pi RPC mode (`docs/rpc.md`, `docs/rpc-commands.md`), pi extension custom messages,
> renderers and widgets (`docs/extensions.md`, `docs/tui.md`), pi-agent scenarios, and the
> tool-ref extension (`docs/tool-ref-design.md`), whose lookup tools and `/ref` panel this design
> mirrors.

## Goal

A leader pi session spawns subagents, each running one scenario or none, and exchanges fixed-format
messages with them for delegation. Focus: agent lifecycle, message protocol, display and lookup.

v1 has one kind of child: the one-shot **task**. Resident **herd** children are planned for the
next version; everything about them is in `docs/subagent-herd-design.md`.

Subagents are built entirely on separate pi processes in RPC mode; no in-process SDK sessions.

## Decisions for v1

1. **Limits:** no behavior limits yet (turn / token / cost / time caps come later). The only
   restriction is **no nesting**: a child can never spawn another child.
2. **What the leader keeps:** only the child's final `result`, stored as a custom pi message in
   the leader session so it is part of the leader's context. Child transcripts are not shown or
   copied; they stay in the child's own session file.
3. **Async only:** spawning returns immediately; the leader is woken when a result arrives. No
   blocking questions in v1.
4. **Kill:** the user can kill a child from the `/agent` popup or with `/agent kill <id>`; the
   leader then records an abnormal `killed` result for it.
5. **IDs:** every child gets its own short ID (`a1`, `a2`, …), separate from tool-ref handles.
6. **Progress is TUI only:** never in the model's context, never persisted. It is derived from the
   child's tool calls (the `// intent:` line), not sent by the child.
7. **Lookup:** the user browses and searches results with `/agent`; the model has
   `subagent_get` / `subagent_grep`.
8. **Session end kills all children** (`/exit`, `/new`, `/resume`, `/fork`, `/reload`); unfinished
   tasks get an `aborted` result. `/new` and `/resume` ask for confirmation first. No reconnect
   after `/reload` in v1.
9. **Restart is a fresh start:** a new child with a new ID; the old child's session is not
   continued.
10. **Start record out of context:** each spawn is recorded with `pi.appendEntry`; the model sees
    the task only through the spawn call and the result.

## Agents

- One child = one process: `pi --mode rpc [--scenario <name>] [--project …]`.
  The scenario fixes the role (prompt, built-in tools, skills). The scenario is optional: without
  one the child is a **general** subagent with pi's own prompt and all built-in tools (useful for
  open-ended tasks, or to let pi read its own docs); it is shown as `general`, and its start
  record and results have no `scenario` field.
- Separate process, not in-process SDK sessions: crash isolation, same path as sandbox runs,
  each child has its own session file.
- No nesting: the leader starts every child with the env marker `PI_AGENT_SUBAGENT=1`. When the
  subagent extension sees the marker it registers only the child-side tool (`send_to_leader`)
  and none of the leader tools, commands or UI, so a child has no way to spawn. (Scenarios
  restrict built-in tools only, so this check has to live in the extension.)
- Star topology: children talk only to the leader, never to each other.

## IDs

- `a<N>`: positive integer, unique within one leader session file, assigned at spawn in spawn
  order. Never reused, also not after a child is reaped.
- Kept separate from tool-ref `#N` handles: results are custom messages, which tool-ref does not
  number, and user-spawned children have no spawn tool call to borrow a handle from.
- On resume the counter continues from the highest ID found in the session's start records
  (see "Lifecycle").
- **Result IDs:** a task has exactly one result, named by the agent ID (`a3`). Records still carry
  a separate `resultId` (equal to the agent ID in v1) so herd results (`a4.1`, see the herd doc)
  fit in later without a format change.

## Kinds

| Kind | Spawned by | Ends when | After end |
|---|---|---|---|
| `task` (one-shot) | leader | sends `result`, or is killed / fails / is aborted | reaped automatically |

Records keep a `kind` field (always `"task"` in v1) for the herd version.

## States

```
spawning → busy → done → reaped
any → failed | killed | aborted → reaped
```

- `spawning` → `busy`: the task envelope is sent with RPC `prompt` once the child is ready.
- `busy` → `done`: the child's `send_to_leader` result arrives.
- `failed`: process exits or crashes without a `result`, or the child settles (`agent_settled`)
  without having sent one (see open question 5).
- `killed`: killed by the leader or manually by the user.
- `aborted`: killed because the leader session ended (see "Lifecycle").
- (`waiting_on_leader` is dropped for v1; it returns with blocking questions.)

## Messages

One envelope for both directions:

```json
{
  "v": 1,
  "id": "msg_…",
  "from": "leader | agent:<id>",
  "to": "leader | agent:<id>",
  "kind": "task | result | control",
  "reply_to": "msg_…",
  "ts": 1731400000,
  "body": {}
}
```

| kind | direction | body | wakes leader |
|---|---|---|---|
| `task` | leader → child | `{text}` | – |
| `control` | leader → child | `{op: kill \| abort}` | – |
| `result` | child → leader | `{status, summary, detailKind?, detail?}` | yes |

- `result.status`: `ok | error` when sent by the child; `killed | failed | aborted` when written
  by the leader on the child's behalf (see "Kill and failure", "Lifecycle"). `aborted` carries
  `reason: "leader_exit"` (or the shutdown reason, e.g. `"reload"`).
- `result.detail` reuses the scenario's `detailKind` schema (`submit_result`).
- No `progress` kind: progress is derived by the leader (see "Progress").
- Deferred past v1: `question` / `answer` (child asks the leader); herd-only `control: reset`.

## Transport

- Leader → child: one RPC `prompt` carrying the `task` envelope; `control: abort` maps to RPC
  `abort`, `control: kill` to a process kill.
- Child → leader: the child-side tool `send_to_leader` sends the `result` envelope; the leader
  reads it from the child's RPC event stream. It is the only child-side tool.
- The leader also reads the child's `tool_execution_start` / `agent_settled` / exit events for
  state and progress.

## Result storage

- Each `result` (normal, killed or failed) is added to the leader session with
  `pi.sendMessage({ customType: "subagent-result", content, details })`.
  - `content`: short text header (`[subagent a3] review · ok · 2m14s`) + `summary`; this is
    what the model sees.
  - `details`: `{ agentId, resultId, scenario, kind, startedAt, endedAt, envelope }`
    (see "IDs").
  - An `aborted` result also puts the task text and scenario in `content`, so the model can
    decide on a restart without having seen the task (e.g. user-spawned children).
- Custom messages are persisted in the leader's session file and participate in LLM context; no
  separate store.
- Besides results, only the start record is stored (out of context, see "Lifecycle"). No
  progress, no transcript.

## Leader inbox

- Async pattern: `spawn` returns the agent ID immediately; the leader keeps working.
- Child → leader results go into one FIFO inbox. Each `result` starts a leader turn.
- Delivery uses `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`: an idle
  leader starts a turn; a busy leader gets it after the current turn. Results pending at the
  same time are delivered together.

## Kill and failure

- Who can kill: the leader (tool), the user from the `/agent` popup (`x`), or the user with
  `/agent kill <id>`.
- A killed process cannot report, so the **leader** writes the result on its behalf:
  `{status: "killed", summary: "killed by <user|leader>", …}`, stored like any other result.
- Same for a child that exits or crashes without a `result`: `{status: "failed", summary: <exit
  code / last error>}`.
- Every spawned `task` therefore ends with exactly one `result` in the leader session.
- Race: a result that arrives before the kill completes wins; a task never gets a second
  result (checked by `resultId` before writing).

## Lifecycle

### Start record

At spawn the leader writes `pi.appendEntry("subagent-start", {...})`: `{ id, scenario, kind,
task, project?, model?, thinking?, startedAt, restartOf?, childSessionId? }` (`scenario` missing for a general subagent). Not in the model's context. Used for
the ID counter, for resume reconciliation and for `aborted` result text.

### Session link

Both directions are recorded when the leader has a session file (else children run `--no-session`):

- **Leader → child:** the leader picks the child's session ID (a UUIDv7, pi's format) at spawn,
  records it as `childSessionId` in the start record (copied into the result details) and starts the
  child with `--session-dir <leader dir>/subagents --session-id <id>`. Its file is
  `subagents/<timestamp>_<id>.jsonl`, known even when the child never reports (leader crash, early
  failure).
- **Child → leader:** the leader sets `PI_AGENT_PARENT_SESSION` (its session ID) and
  `PI_AGENT_PARENT_AGENT` (`a3`) in the child's environment; the child appends a
  `pi-agent.parent` entry `{ sessionId, agentId }` at session start (once). session-upload sends it
  as `x-pi-parent-session-id` / `x-pi-parent-agent-id` headers (shared/parent-link.ts).

### Process group

Children stay in the **leader's process group** (Node `spawn` without `detached`, the default).

- The leader signals children **per PID**, never the group: a group signal would hit the leader
  too.
- Terminal signals reach the whole foreground group, so children get them directly:
  - SIGHUP (terminal closed): children start their own orderly shutdown (pi RPC treats SIGHUP
    like SIGTERM), in parallel with the leader's shutdown sequence.
  - Ctrl+C in the interactive TUI: the terminal is in raw mode, so it is a key press, not
    SIGINT, and children are not affected. Without the TUI (e.g. a `pi-agent run` leader) a
    SIGINT kills a child at once without a shutdown (see "Spike results"); reconciliation covers it.
- Leader killed with SIGKILL: only the leader dies; children shut down on stdin EOF (see
  "Orphans").

### Shutdown sequence

For every live child, in parallel:

1. Close its stdin and send SIGTERM (pi RPC: orderly shutdown, session file written).
2. Wait up to ~2 s.
3. SIGKILL whatever is left.

Then append one `pi.appendEntry("subagent-end", { id, status: "aborted", reason })` per unfinished
task. The `aborted` result **message** is written by the next `session_start` of that session
(see "Resume reconciliation"), not here: the spike showed that a `sendMessage` during
`session_shutdown` is lost when the leader is still streaming, while `appendEntry` is always
written. The session end never waits longer than the grace period.

### Session end (`session_shutdown` reasons)

| reason | trigger | before | children |
|---|---|---|---|
| `quit` | `/exit`, Ctrl+C/D, SIGHUP, SIGTERM | – | shutdown sequence, `aborted` results |
| `new` | `/new` | confirm in `session_before_switch` ("N agents running, kill them?"); No cancels the switch | shutdown sequence, `aborted` results in the old session |
| `resume` | `/resume` | same confirm as `new` | same as `new` |
| `fork` | `/fork` | – | shutdown sequence, `aborted` results in the old session; the fork reconciles its copied start records on start |
| `reload` | `/reload` | – | shutdown sequence, `aborted` results (`reason: "reload"`); no reconnect in v1 |

With no child alive, none of these do anything.

### Resume reconciliation

On every `session_start` (`startup`, `reload`, `new`, `resume`, `fork`), for each start record
on the active branch without a matching result message: write the `aborted` result message, with
the reason from its `subagent-end` entry, or `"leader_exit"` when there is none (leader crash,
SIGKILL, SIGINT: `session_shutdown` never ran). Idempotent: a task with a result message is
skipped. After `/reload` this runs right away in the same session.

- Delivered without `triggerTurn`: a resume never starts a turn by itself. The model sees the
  results on the next prompt.
- The user gets a notice: `2 tasks aborted at exit: a3, a5`.
- Start records on abandoned branches are ignored.

### Orphans

If the leader dies without running any handler (SIGKILL), each child's RPC stdin pipe closes,
which starts its own orderly shutdown (pi RPC: stdin EOF). Resume reconciliation then records the
`aborted` results.

### Restart

Fresh start only (v1): a restart spawns a new child with a new ID, the same scenario and task,
and `restartOf: "a3"` in its start record. The old child's session file is not continued. Model
tool `subagent_restart({ id })`; user command `/agent restart <id>`.

## Display (interactive UI)

### Result row

`pi.registerMessageRenderer("subagent-result", …)`, kept minimal, styled like the compact
codemode rows of tool-ref:

```
[subagent] a3 · review · ok · 2m14s
<task, one line, at most 120 chars, ... when cut>

/agent a3 for details
```

- The row sits between two full-width rules (`DynamicBorder`) in the theme's `warning` colour
  (amber); no background. The label is bold `accent` (pink), like codemode's; `ok` green, every
  other status red.
- Rows never expand (`ctrl+o` changes nothing): the full result is in the `/agent` panel. A left
  click on the row (fullscreen mode) opens that panel.

### Progress

Display only: never sent to the model, never written to the session, lost on restart.

**Source:** the child's RPC `tool_execution_start` events. For `codemode` the line is the
script's `// intent:` comment (tool-ref's `scriptIntent()`); other tools show
`<tool> <first argument>`, cut to one line. No child cooperation needed.

**One line per state:**

| state | line |
|---|---|
| spawning | `starting <scenario>…` |
| busy | latest intent (`thinking…` between tool calls) |
| done | `done · <status>` (removed once the result row appears) |
| failed | `failed · exit <code>` |
| killed | `killed by user` |

**Widget** above the editor (`ctx.ui.setWidget`), in the footer's grey (theme `dim`), one line per live child, at most ~5 lines then
`+k more`:

```
● a3 review   busy  1m20s  check auth middleware for token reuse
● a5 triage   busy  0m12s  starting triage…
```

Plus a count at the right end of the footer's first line (cwd, branch, session name), dimmed
like it: `🤖 2 busy · 1 starting`. Both cleared when no child is alive. pi has one footer, so the
footer is shared with the tags extension (tags left of the cwd) through `src/shared/footer.ts`;
outside the TUI the count is a `setStatus` status.

The leader keeps the last N progress lines per live child in memory for the popup.

### `/agent` command and popup

For the user, like tool-ref's `/ref`; reuses its panel (`RefViewer`, generalized to take any
page builder): overlay, same size and scroll keys.

- `/agent a3`: one child.
- `/agent`: pages through all children of the session (live and finished), opens at the newest;
  ←/→ older/newer.
- `/agent grep <regex>`: pages through the results that match (same matching as
  `subagent_grep`).
- `/agent kill <id>`: kills a live child (see "Kill and failure").
- `/agent restart <id>`: fresh restart (see "Lifecycle").

Page content:

- **Finished child:** header (ID, scenario, status, start, duration), then the full
  `summary` and `detail`.
- **Live child:** header (ID, scenario, state, running time), then its recent progress
  lines (in memory). Refreshes while open. `x` kills it (with confirm).
- No child transcript in v1.

Other modes (`ctx.mode !== "tui"`): text goes to a notification, as with `/ref`.

## Model tools (leader only)

Besides spawning, killing and `subagent_restart`, the leader model gets two lookup tools,
shaped like tool-ref's:

- `subagent_get({ ids, lines?, maxChars? })`: the stored result of each ID (header + summary +
  detail, numbered lines). A live child returns its state and running time, not progress.
- `subagent_grep({ pattern, ids?, context? })`: regex over stored results (summary and detail),
  newest first, with line numbers for `subagent_get`.
- Like tool-ref: active branch only, read from raw session entries, so compaction does not hide
  results from lookup.

## Spike results (pi 1.5.0, `pi --mode rpc`)

Run with a scripted faux model loaded by `-e` and a tool that sleeps 4 s, ended while the tool runs:

| End | Exit | `session_shutdown` | `appendEntry` in it | `sendMessage` in it |
|---|---|---|---|---|
| stdin EOF | code 0 after ~40 ms (does not wait for the running tool) | yes, `reason: "quit"` | written | lost while streaming; written when idle |
| SIGTERM | code 143, ~40 ms | yes | written | as EOF |
| SIGHUP | code 129, ~40 ms | yes | written | as EOF |
| SIGINT | killed by the signal at once | **no** | – | – |

- Event shapes as documented: `tool_execution_start` has `toolCallId`, `toolName`, `args`
  (extension tools too); `agent_settled` has `aborted`.
- `get_state` returns `sessionFile`; the file exists once the first assistant message is written.
- Consequences: shutdown writes `subagent-end` entries, result messages come from reconciliation;
  a SIGINT to the group (Ctrl+C with a non-TUI leader) kills children without a shutdown, which
  reconciliation covers (`reason: "leader_exit"`).

## Tests (lifecycle)

Integration tests with real child processes (a stub scenario that waits on a tool):

- Leader killed with SIGKILL: every child exits on stdin EOF within the grace period; no
  orphans left (check by PID / process group).
- Resume after that SIGKILL: one `aborted` result per unfinished task, none for finished ones;
  a second resume adds nothing.
- `/exit` with busy children: SIGTERM path, SIGKILL fallback for a child that ignores SIGTERM,
  exit within the grace period.
- `/new` / `/resume`: confirm No keeps the children; Yes kills them and writes `aborted` in the old
  session.
- `/reload`: children killed, `aborted` results with `reason: "reload"`, new instance starts with
  none alive.
- `/fork`: old session and fork each end up with one `aborted` result per task.
- SIGHUP to the process group (terminal closed): leader and children all shut down; resume
  reconciles the results.
- Race: a result that arrives during the shutdown sequence wins over `aborted`.

## Implementation notes

Where v1 differs from or adds to the sections above:

- **Files:** `protocol.ts` (names, records), `records.ts` (branch index, reconciliation),
  `format.ts` (texts, progress, lookup), `rpc.ts` (JSONL client), `manager.ts` (live children),
  `child.ts` (`send_to_leader`), `render.ts` (result row), `viewer.ts` (`/agent` panel),
  `index.ts` (wiring). Loaded from `dist/subagent.js`: scenarios import `.md` files.
- **Child command:** the leader's own pi (`process.execPath` + `process.argv[1]`), overridable
  with `PI_AGENT_SUBAGENT_COMMAND` (JSON argv). Args: `--mode rpc [--scenario X] [--project P]
  --model <provider/id> --thinking <level> --name "subagent aN (X)"` (X is `general` without a scenario) and `--session-dir <leader dir>/subagents`
  (`--no-session` when the leader has none). The child's cwd is the leader's entered worktree
  (worktree extension), else the leader's cwd.
- **Model and thinking:** `subagent_spawn` takes `model` (exact `provider/id` of a model with
  credentials, `modelRegistry.getAvailable()`, or the leader's own) and `thinking` (`off` … `max`,
  pi clamps it to the model). Both default to the leader's at spawn and are recorded in the start
  record, so a restart reuses them even after the leader switched. Records without them: the
  leader's current ones.
- **Task prompt:** plain text (task, then how to call `send_to_leader` with the scenario's detail
  schema), not the JSON envelope. The envelope is kept in the result's `details`.
- **`send_to_leader`:** `{ status: ok|error, summary, detail? }`; `detail` is validated against
  the scenario's schema when given; `terminate: true`. The leader reads `details.body` from
  `tool_execution_end`.
- **Delivery:** results wait in the inbox until the leader is idle (checked at once and on
  `agent_settled`); all waiting results are sent together, only the last with `triggerTurn`.
  `killed` results (by user or leader) are recorded without starting a turn.
- **`subagent-end`** entries carry the full result details (also a real result that arrived during
  shutdown, and results still waiting in the inbox).
- **Start record:** `childSessionId` (chosen at spawn), no `childSessionFile` (only known after
  start, from `get_state`); both are in the result details.
  `startedBy: "user"` when the user started it (`/agent restart`); missing means the model.
- **Who started it:** the model sees its own starts as `subagent_spawn`/`subagent_restart` calls,
  so those stay out of context. A user start also sends a `subagent-user-start` custom message
  (`[subagent a5] started by user: restart of a2 (demo)` + the task), without a turn. Every result
  header the model gets adds `· restart of a2` and `· started by user` when they apply; the row in
  the TUI shows `↻ a2`.
- **Panel:** its own `AgentViewer` (sized and keyed like `/ref`, reusing its overlay size), not a
  generalized `RefViewer`; live pages refresh every second.

## Open questions

Owner's list; added to as discussion goes.

1. **Behavior limits** (future): tool-call / turn caps, token and cost budgets, wall-clock
   timeouts, early stop, …
2. **Blocking questions** (future): `ask_leader` via RPC `extension_ui_request` /
   `extension_ui_response` (**to verify** in `docs/rpc-extension-ui.md`), with timeouts and a
   `default` answer to avoid leader/child deadlock.
3. **Stuck children:** detecting and reaping children that never settle (needs limits, item 1).
4. **Child transcript in the popup** (future): read the child's session file on demand.
5. **Task child settles without `send_to_leader`:** v1 treats it as `failed` ("ended without
   calling send_to_leader"). Alternative: one reminder `follow_up` first.
6. **Herds** (next version): see `docs/subagent-herd-design.md`.

### Parked (from the first draft)

- Leader type: interactive session, `pi-agent run` sandbox, or both.
- Max concurrent children.
- User talking to a child directly vs only via the leader.
- Child results in `report.json` (additive fields only).
