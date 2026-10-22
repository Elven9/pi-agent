# Design: tool-call references (`tool-ref` extension)

> Status: **implemented** (`src/tool-ref/`, `src/shared/tool-ref.ts`); see "Implementation notes"
> at the end for decisions made while implementing.
> Based on pi `@earendil-works/pi-coding-agent` 1.4.0 (repo pin and global install):
> `docs/extensions.md`, `docs/session-format.md`, `docs/compaction.md`, `docs/settings.md`,
> `dist/core/extensions/runner.js` (`emit`, `emitToolResult`), the bundled `AgentSession`
> (`_afterToolCall`, `reload`), `dist/core/session-manager.js` (`_buildIndex`, `branch`) and
> `dist/core/settings-schema.js`.
> Runtime behaviour was checked with a throwaway SDK spike (faux provider, see "Spike results").

## Goal

Give every tool call in a session a short, stable number that the model can cite and look up
cheaply. Reports built later on top of this (experiment blocks, result system) store these
numbers instead of copying commands and output, so they record exactly what ran and cost few
tokens.

The extension provides:

1. A **handle** (`#12`) added to every tool result as it is created.
2. `tool_ref_get`: one or more results by handle, with a line range to keep output small.
3. `tool_ref_grep`: find calls by regex over their input and output. There is no
   `tool_ref_list` index tool; grep covers listing too (see "`tool_ref_grep`").
4. A resolver module other extensions (report system) import to turn handles into data.

Out of scope for now:

- **Forks** (`/fork`, `/clone`, runner `--resume`). Handles copied into a fork keep working
  in the fork; identity across sessions is not handled (see "Forks").
- **Session server, global references, reports.** This is the in-session base they build on.
- **User shell commands** (`!cmd`, `bashExecution` messages). They are not tool calls.
- **Nested calls** (codemode scripts). Not used in this setup. Known gap: pi keeps a bounded
  record of them as `nestedCalls` on the parent's result message, so a later version could
  index them as sub-handles (`#12.3`) without changing trailers. In v1 only the parent call
  gets a handle.

## Rules

| # | Rule |
|---|---|
| R1 | Handles are positive integers, unique **within one session file**, assigned in the order result messages are finalized (call order within a batch). |
| R2 | The handle is stored **in the tool result content** (trailer text block). That persisted content is the only source of truth; no side table. |
| R3 | Only the **active branch** is visible. `get` and `grep` never return calls from abandoned branches. |
| R4 | Data is read from **raw session entries**, never from the model context, so compaction and `context_edit` do not hide anything from the resolver. A `context_edit` replacement or omission is ignored: `get` and `grep` return the original content, with no marker. |
| R5 | The extension never changes what a tool returned, other than appending the trailer. |
| R6 | **Every** top-level tool result message gets a handle, whatever produced it (tool, block, validation error, length cut). Exclusion only controls what `get` and `grep` may read, never numbering. |

## Handle trailer

Appended by a **`message_end` handler** as one extra text block at the end of `content`, for
messages with `role === "toolResult"` only (other roles are returned unchanged):

```
[tool-ref #12]
```

- The trailer is **its own content block**, never merged into the tool's text. Parsing (see
  "Parsing and collisions" for the exact rules): the last content block, searched from the
  end, whose whole text matches `^\[tool-ref #(\d+)\]$`. Text that only *ends* with such a
  line (e.g. `cat` of this doc or of a session file) does not match.
- Image-only and empty results get the text block too.
- About 6 tokens per call. The model sees the number right after the output it belongs to.
- Prompt cache: pi runs `message_end` handlers before it saves the message and before the
  next model request, so the message never changes afterward.

### Why `message_end` and not `tool_result`

The spike (see "Spike results") showed that pi creates some results without calling
`tool_result`: calls blocked by a `tool_call` handler, unknown tools, invalid arguments and
length-cut turns. All results, including those, become `toolResult` messages and go through
`message_end`. So one `message_end` hook numbers every result, with no second code path.

- pi emits the result messages of a batch in **call order** (also for parallel execution),
  so numbers follow call order and are deterministic.
- `message_end` handlers run before persistence; a returned `message` replaces the
  finalized one in place (agent state, later events, subscribers, session file). It must keep
  the role. Checked in 1.4.0 (`AgentSession._emitExtensionEvent`, `_replaceMessageInPlace`)
  and in the spike.
- Nested calls (codemode) produce no messages, so they are skipped without a check.
- `tool_execution_end` (and anything reading it) never sees the trailer; consumers read the
  `toolResult` `message_end` instead (see "`report.json` tool log").
- `structuredContent` is not part of the message, so the `tool_result` rule "return
  `structuredContent` or lose it" does not apply.
- Idempotent: a message whose content already has a trailer (guard 2) is returned
  unchanged, so a repeated `message_end` never numbers a result twice.

### Parsing and collisions

The risk is a **missing** trailer, not a look-alike one: while our trailer is present it
comes after anything the tool printed, so a tool output of `[tool-ref #3]` can't win. A wrong
handle needs our trailer missing **and** a tool output block that is exactly
`[tool-ref #N]`. A trailer can be missing when a later `message_end` handler replaced the
message content (load-order task), or in sessions recorded before tool-ref was installed.

Guards:

1. **Only `toolResult` messages are parsed.** User, assistant and custom messages that quote
   `[tool-ref #3]` never define a handle.
2. **Search from the end for the last exact block.** The handle is the last content block
   (searching backwards) that is a text block exactly matching the trailer pattern, not only
   the very last block. A later handler that *appends* a block (a note, a warning) then keeps
   the handle; only handlers that *replace* `content` lose it. Cost: when our trailer is
   missing, an exact-match block anywhere in the output counts, not only at the end; same
   rare case as before.
3. **Duplicates are reported, not guessed.** Numbers are unique per file by construction
   (R1), so the same `N` on two results anywhere in the file (any branch) proves a collision.
   The resolver marks `N` as ambiguous: `get #N` returns "#N is ambiguous (2 results claim
   it)", and `grep` shows those calls without a handle (`#?`). The startup counter scan still
   takes the max over all parsed numbers (a forged high number only skips numbers, which is
   harmless).

### Why the content and not `details` or a custom entry

| Option | Problem |
|---|---|
| Merge into the tool's `details` | `details` belongs to each tool (renderers, the runner's `submit_result`, the todo example read their own shape). Adding keys risks breaking them. |
| `pi.appendEntry()` custom entry mapping handle → toolCallId | A second record that can drift from the first. Ordering against the result entry under parallel calls is unclear. More to rebuild. |
| **Trailer in content** | What the model saw and what the resolver reads are the same bytes. Survives reload and resume. No extra state. |

### Which calls get a handle, and which can be read

| Call | Handle | Readable by `get` / `grep` | Why |
|---|---|---|---|
| Top-level tool calls, success **and error** | yes | yes | Failed attempts are evidence in experiments |
| Tools in `toolRef.exclude` (default `submit_result`) | yes | no: "excluded" error in `get`, silently skipped by `grep` | Plumbing tools. Numbered anyway (R6), so numbering has no gaps that depend on settings, and a later settings change doesn't leave unnumbered calls |
| `tool_ref_get`, `tool_ref_grep` | yes | no: as above | Always excluded. Looking things up is not evidence; avoids handles pointing at handles |
| Blocked by a `tool_call` handler, unknown tool, invalid arguments, length-cut turn | yes | yes | pi's own error results; numbered via `message_end` like any other result |
| Nested calls (e.g. from codemode) | no | no | Out of scope for v1 (see above). They produce no messages, so `message_end` never sees them |
| Calls queued behind an abort (sequential execution) | no | — | pi writes **no** result message for them at all, not even later; nothing to number |

Reading an excluded handle returns an error naming the tool, e.g. "#7 is a submit_result call,
which tool-ref does not show (toolRef.exclude)", so the model doesn't retry or search for it.

### Settings

One custom key in pi `settings.json` (global `~/.pi/agent/settings.json` or project
`.pi/settings.json`). pi's settings schema accepts extra top-level keys
(`additionalProperties: true`), and `pi.getSettings()` returns the merged global + project
values.

```json
{
  "toolRef": {
    "exclude": ["submit_result"]
  }
}
```

Checked (spike): `pi.getSettings().toolRef` returns the merged value; a project value
**replaces** the global `exclude` list (no list merge); project settings are ignored when the
project is not trusted; a settings write (`setDefaultThinkingLevel`) keeps `toolRef` in the
file.

- `exclude`: tool names whose results `get` and `grep` refuse to show. They still get a
  trailer (R6). Default `["submit_result"]` when the key is missing. `tool_ref_get` and
  `tool_ref_grep` are always excluded and need not be listed.
- Read at `session_start`, so a change applies after `/reload`. Because numbering ignores
  `exclude`, changing it only changes what is readable, for old and new calls alike.
- A project `exclude` replaces the global one, so a project that adds a tool must repeat the
  global entries (and `submit_result` if it wants it excluded).

### Assigning numbers

- Counter state is **process-global**, keyed by session id:
  `globalThis[Symbol.for("pi-agent.tool-ref")]: Map<sessionId, next>`. A module-level
  variable is not enough, because `/reload` creates a new extension instance (see the reload
  race below).
- Initialize **lazily**, on the first `toolResult` `message_end` or at `session_start`,
  whichever comes first: scan `ctx.sessionManager.getEntries()` (**whole file**, all branches) for trailers and
  set `next = max(scan max + 1, stored next)`, or 1 for a new session. The scan is synchronous.
- `message_end` with `role === "toolResult"` and no trailer yet: take `next++`
  **synchronously, before any `await`**. pi emits result messages one at a time in call
  order, so numbers follow call order; taking the number synchronously keeps them distinct
  even if that ever changes.
- Numbering is **per file, not per branch**. After `/tree`, a new branch continues after the
  highest number in the file, so a number never means two different calls in one file, even
  across branches. R3 still decides visibility.

#### Reload race (checked in 1.4.0)

- Interactive `/reload` refuses while the agent is streaming or compacting
  (`handleReloadCommand`), so it never overlaps a tool result.
- `ctx.reload()` from an extension command is not guarded in print and RPC mode
  (`session.reload()` directly), and extension commands run immediately even while streaming
  (`AgentSession.prompt`). So a reload can happen during a turn.
- `AgentSession.reload()` installs the new extension runner (`_buildRuntime`) **before** it
  emits `session_start`, and `message_end` goes to `this._extensionRunner` as it is when
  the message ends. A result can therefore reach the new instance before its `session_start`, and the
  old instance may have numbered a result that is not persisted yet when the new one scans.
- Both cases are covered by the process-global counter and lazy init above: the new instance
  continues from the number the old one handed out, not only from what is in the file.

### Interplay with other handlers

pi runs `message_end` handlers in extension load order; each sees the message returned by
the earlier ones.

- `tool_result` handlers run earlier (when the tool finishes), so any content they change,
  e.g. a redaction, is already in the message tool-ref numbers. They are no longer a
  concern.
- A later `message_end` handler that replaces a `toolResult` message's content can remove
  the trailer. `tool-ref` must load **last** among extensions with `message_end` handlers
  that replace tool results; enforced for pi-agent extensions by a load-order check (see
  "Load order"). A result without a trailer has no handle; `get` can't reach it. The
  resolver still indexes it by `toolCallId` for other extensions.

## Load order

Two order requirements, both on handler order, which follows extension load order:

| Requirement | Why | Check |
|---|---|---|
| scenario-profile before project | `<rules>` must be added before the project sections, so it stays in cache block A | **Implemented.** Under `--scenario`, scenario-profile listens on `PROJECT_CHANNEL`; if the project extension announces itself (it does in its `session_start`) before scenario-profile's own `session_start` ran, the project loaded first. Error entry (`pi-agent.error`) and shutdown, like an unknown scenario. Test: `src/scenario-profile/load-order.test.ts` |
| tool-ref last among `message_end` handlers that replace `toolResult` messages | A later handler can drop the trailer | **Implemented.** Rewriters announce on `TOOL_RESULT_REWRITER_CHANNEL` from `session_start`; an announcement after tool-ref's own `session_start` → error entry and shutdown. Covers **pi-agent extensions only**; extensions outside this package are not checked. Test: `src/tool-ref/load-order.test.ts` |

The runner (`src/wrapper/pi-command.ts`) and the package manifest already list scenario-profile
before project.

## Resolving a handle

The resolver walks `ctx.sessionManager.getBranch()` once and builds, per handle:

| Field | Source |
|---|---|
| `handle` | trailer of the `toolResult` message (guards under "Parsing and collisions") |
| `toolCallId`, `toolName`, `isError` | `toolResult` message |
| `excluded` | `toolName` is in the exclude list (or is a tool-ref tool) |
| `input` | the matching `toolCall` block (same id) in the preceding assistant message on the branch |
| `output` | `toolResult` content without the trailer; images as `[image]` |
| `startedAt`, `endedAt`, `durationMs` | assistant message timestamp, tool result timestamp (approximations); `durationMs` from the `toolResult` message (pi 1.4.0 stores it, optional) |
| `entryId` | session entry id of the tool result |

Duplicate detection (guard 3) needs the numbers of the **whole file**, not just the branch:
one extra pass over `getEntries()` collecting handle → count. Results claiming an ambiguous
number are indexed by `toolCallId` only.

Indexing is linear in session length. Sessions are thousands of entries at most, so rebuild on
each lookup. Cache by `getLeafId()` only if that turns out to be slow.

Results without a trailer are indexed by `toolCallId` only (resolver API for other
extensions; the model-facing tools take handles only).

A handle not on the active branch is an error that says so ("#12 is not on the active
branch"), not "unknown", so the model doesn't search for it.

## Tools

Read-only (`annotations.readOnlyHint: true`), `exposure: "direct"`, compact text for the
model plus `details` with the full objects for renderers and other extensions.

### `tool_ref_get`

| Param | Meaning |
|---|---|
| `refs` | one or more handles (`[12, 14]`), at most **10** per call; batch to save round trips |
| `part` | `output` (default), `input`, or `both` |
| `lines` | line range of the **output**, e.g. `[1, 80]` or `[-50, -1]` for the tail |
| `maxChars` | per-ref cap, default ~4000; the result says what was cut and how to get the rest |

- More than 10 refs is an error (the model splits the call). With `maxChars` that bounds one
  call to about 40k characters.
- `lines` applies to the output only; with `part: both` the input is shown whole (it is
  short; capped by `maxChars` like everything else).
- No pattern search here: that is `tool_ref_grep` (with `refs` to search given calls), so only
  one tool searches and the output format is the same everywhere.
- Output starts with a header per ref (`#14 bash ERR · input: apfs-fuse …`) and keeps original
  line numbers so later calls can request exact ranges. Multi-line input in the header is cut
  to its first line plus `…`.
- Per-ref errors (excluded, not on the active branch, unknown) are reported inline for that
  ref; the other refs are still returned.

### `tool_ref_grep`

Finds calls on the active branch by regex. Replaces the earlier `tool_ref_list` idea: no index
listing, no pagination.

Why grep and not full-text (ranked) search: a session holds at most a few MB of tool output,
so a linear regex scan per call is cheap and fits easily in what a current model can use;
grep is deterministic; and models already know grep and `rg` semantics, so there is nothing
new to learn. Ranked search only helps fuzzy recall over large corpora.

| Param | Meaning |
|---|---|
| `pattern` | JS regex, matched **line by line**. Smart case like `rg`: case-insensitive unless the pattern contains an uppercase letter. An invalid pattern is an error naming the pattern |
| `in` | `input`, `output`, or `both` (default `both`). `input` answers "when did I run X / touch file Y" without output noise |
| `refs` | optional: search only these handles (at most 10, like `get`) |
| `tool` | optional: tool name(s) |
| `errors` | optional: `true` only failed calls, `false` only successful ones |
| `context` | lines of context around each match, default 0 |

Output: matches grouped by call, **newest first**, with original line numbers so a
follow-up `tool_ref_get` can ask for exact `lines`:

```
#14 bash ERR  apfs-fuse /dev/sdb2 /mnt/mac
  out:2  apfs-fuse: no such device
#9  bash ok   apfs-fuse -l /dev/sdb
  in:1   apfs-fuse -l /dev/sdb
  out:7  /dev/sdb2  apfs  ...
… 23 more matches in 6 calls (narrow with tool/refs/in)
```

- Header per call: handle, tool, `ok`/`ERR`, one-line input summary (`bash`: command,
  `read`/`edit`/`write`: path, others: shortened JSON; multi-line input cut to its first
  line plus `…`).
- Matching lines are prefixed `in:N` / `out:N`; context lines use the same numbering.
- Caps: about 5 matching lines per call and 50 in total; the last line says how many
  matches in how many calls were left out and how to narrow. A matching line longer than
  about 200 characters (minified JSON, base64) is cut to a window around the match.
- Listing is a grep: `pattern: ".", in: "input", tool: "bash"` lists the commands run, newest
  first.
- Scope: active branch only (R3). Excluded calls are skipped **silently** (unlike `get`, the
  model did not ask for them by number). Images are skipped. Compaction and branch summaries
  are not searched: they are not tool calls.

Known limits:

- **Only what was persisted.** Both tools read the result `content` in the session. pi's
  `bash` keeps the last 2000 lines / 50KB there and saves the full output to a temp file
  (named in the text and in `details.fullOutputPath`); text beyond that cut is not
  searchable. The temp file may be gone later. Not handled in v1.
- **No multi-line patterns.** Matching is per line, like grep; `context` covers most needs.

### Prompt guidance (tool `promptGuidelines`)

Text:

- Every tool result ends with `[tool-ref #N]`. Cite evidence by number, not by copying output.
- To see earlier results again, use `tool_ref_get` (with `lines`) instead of re-running the
  command.
- To find earlier calls, e.g. after context was summarized, use `tool_ref_grep`.

Where: `promptGuidelines` of `tool_ref_get` (all lines on one tool, so they appear once). pi
renders tool guidelines in `<rules>`, only while the tool is active.

pi builds `<rules>` only for its default prompt, not when `customPrompt` is set. The
scenario-profile extension adds a `<rules>` section back under `--scenario`, with only the
`promptGuidelines` of active extension tools (built-in tools' rules and pi's fixed rules stay
out; `scenarioRules` in `src/scenario-profile/profile.ts`).

Position in the prompt (pi 1.4.0 `buildSystemPromptSections`):

| Mode | Sequence |
|---|---|
| no `--scenario` | preamble, `<tools>`, **`<rules>`** (pi's, all tools), `<docs>`, `<addendum>`, `<project_context>`, `<skills>`, `<cwd>`, project sections |
| `--scenario` | scenario preamble, `<addendum>`, `<project_context>`, `<skills>`, `<cwd>`, **`<rules>`** (extension tools only), project sections |

In both modes it is in cache block A (before the project sections). Under `--scenario` that
relies on scenario-profile loading before the project extension, which is now checked at
session start (see "Load order").

Rules:

- **Constant text.** No counts, dates or session data, so it never changes within a session
  (pi sends no prompt delta) or across sessions (block A cache stays valid).
- Under `--scenario`, `<rules>` holds the guidelines of every active extension tool, so its
  text is shared only by setups with the same extension tools.

## Resolver module (for other extensions)

Exported functions, no pi state of their own, so the report system and tests use them directly:

- `parseHandle(content) → number | undefined`
- `indexBranch(entries, leafId, exclude) → { byHandle: Map<number, ToolRef>, byToolCallId: Map<string, ToolRef>, ambiguous: Set<number> }`
  (all file entries, for duplicate detection; the branch is walked from `leafId`. Excluded
  calls are indexed with `excluded: true`, so `get` can say why it refuses)
- `formatGet(ref, options)`, `grepRefs(index, options)` / `formatGrep(matches, options)`
- `loadSettings(settings) → { exclude: string[] }` (defaults applied); `indexBranch` takes
  the exclude list so live and offline indexes agree

Live data comes from `ctx.sessionManager`; offline data (uploaded session files) from parsing
JSONL and walking `parentId` from the **last entry in the file**. One code path for both.

Checked in 1.4.0: that is how pi itself picks the leaf when it loads a file
(`SessionManager._buildIndex` sets the leaf to the last entry), so the offline branch is the
one `--resume` would continue. The live leaf can differ only after `/tree` navigation that
appends nothing (`branch()` without a summary moves the leaf without writing an entry); the
next appended entry makes file and live leaf agree again. Accepted.

## Branches

- **Rule:** only the active branch counts. A report or a citation made on a branch that was
  later abandoned is abandoned with it.
- Consequence for later consumers: anything that caches "the calls of this session" must
  rebuild on `session_tree`. The tools here don't cache, so nothing to do.
- Numbering stays file-wide (see above), so returning to an old branch never makes an old
  citation point at a different call.

## Compaction

- Handles survive in the raw entries; resolving is unaffected (R4).
- The model loses sight of older handles. `tool_ref_grep` is the way back.
- Future, not in this version: hook `session_before_compact` to keep a short handle index in
  the summary, or warn about calls no report has cited yet.

## Forks (not handled)

What happens anyway, for the record:

- `/fork` and `/clone` copy the active path; runner `--resume` copies the whole file. Copied
  results keep their trailers, so old handles resolve in the new session too.
- The new session continues numbering after its own max. `/fork` and `/clone` copy only the
  active path, so the child's max can be lower than the parent file's: the child can reuse
  numbers the parent used on abandoned branches. Parent and child can also both assign `#N`
  to different new calls. That only matters for references across sessions, which the
  result system will have to scope by session id.

## Where it loads

Both personal pi (the CLI agent) and the runner load tool-ref, **last** in both:

- Package manifest (`package.json` `pi.extensions`): add the tool-ref entry after all others.
- Runner (`src/wrapper/pi-command.ts`): add `-e <dist/tool-ref.js>` after the other `-e`
  flags; `build.mjs` gets a `tool-ref` entry point. The runner passes `--tools` as a hard
  allowlist (`scenario.tools` + `submit_result`), so `tool_ref_get` and `tool_ref_grep` must
  be added there too, or they are never active.
- Under `--scenario`, `scenarioActiveTools` keeps extension tools, so both tools are active
  in every scenario.

## Display (interactive UI and HTML export)

The trailer is **hidden in the UI** and **kept in the session file** (and in what the model
sees). Display only:

- tool-ref registers a `pi.registerToolRenderer` resolver for every tool name. It returns the
  renderers `next()` gives, with `renderResult` wrapped so it receives the result with the
  trailer block removed.
- Tools without their own `renderResult` (pi then shows a plain-text fallback) and tools with
  no definition (e.g. MCP tools not connected yet) need a tool-ref fallback renderer that
  draws the text output without the trailer, close to pi's fallback.

Checked in 1.4.0 source:

- **Whole set, not per field.** `runner.resolveToolRenderers` calls resolvers in load order;
  the first one's return value is used as the tool's renderer set (`renderShell`,
  `renderCall`, `renderResult`). So tool-ref returns `{ ...next(), renderResult: wrapped }`.
  Interactive mode's base is `withBuiltInRenderers(name, definition)`, so `next()` includes
  the built-in `bash`/`read`/`edit` renderers and wrapping keeps their look.
- **No `renderResult` in `next()`**: pi would use `createResultFallback` (text output, first
  lines, expand hint), which is not exported. tool-ref supplies its own close copy of it.
- **`next()` undefined** (no definition, e.g. MCP tool not connected): returning a set
  switches pi from its plain fallback to the boxed layout with `createCallFallback` for the
  call. Acceptable; or return `undefined` there and accept the trailer for such tools.
- **HTML export: only partly hidden.** Its resolver base is the bare tool definition (no
  built-in renderers), and the template renders built-in tools itself from the raw content
  when a definition has no `renderResult`. A tool-ref `renderResult` would replace the
  template's own rendering of `bash`/`read`, and the embedded session data and text previews
  still contain the trailer. Decision: hide in the interactive UI only; HTML export shows the
  trailer. Open detail: the resolver can't tell interactive from export (`next()` is
  opaque), so "add a fallback `renderResult` only in interactive mode" needs a way to
  tell them apart, or the fallback is skipped and tools without their own `renderResult`
  show the trailer in both.

## `report.json` tool log

The runner's tool log (`src/wrapper/tool-log.ts`) reads `tool_execution_end`, which is
emitted before `message_end` and so never has the trailer. The `toolResult` `message_end`
event carries the final content (subscribers, and so pi's JSON stream, see `message_end`
replacements; checked in the spike). The tool log keeps timing and `output` from
`tool_execution_end` and takes `ref` from the `toolResult` `message_end`, matched by
`toolCallId`.

- New field on `ToolCallLog` (`src/shared/report.ts`): `ref: number | null`, the handle
  parsed from the result; `null` if the call has none (nested call, unfinished call, trailer
  missing).
- `output` stays as it is: it comes from `tool_execution_end`, which never has the trailer.
- Parsing uses the same `parseHandle` as the resolver; it moves to `src/shared/` so the
  wrapper bundle and the extension share it. The tool log parses each result on its own; it
  does not detect duplicates (guard 3), which stay a resolver concern.
- The field is additive, so `REPORT_VERSION` stays 1. README's `toolCalls` field list gets
  `ref`.

## Modes

Works in interactive, print, JSON and RPC modes. Only interactive mode and HTML export draw
tool results (see "Display").

## Open items

- Checked in 1.4.0 source: `message_end` runs before persistence and replaces in place,
  nested calls produce no messages, `context_edit` is a content replacement
  (`ContextEditEntry.replacement`), settings accept extra keys, the reload race (exists in
  print/RPC, see "Reload race"), how pi picks the leaf of a loaded file.
- Checked in the spike: see "Spike results".
- Checked during implementation: the interactive UI draws a live result from
  `tool_execution_end` (no trailer; `interactive-mode.js` `updateResult`), and results loaded
  from the session from the message (with trailer). The renderer wrapper handles both.
- Exact output caps for `get` and `grep` (per-call and total match caps, line window), after
  trying on real sessions. Implemented with the values above (4000 chars per ref; 5 / 50
  matching lines; 200-char window) as constants in `src/tool-ref/format.ts`.

## Spike results

Throwaway SDK spike (`tmp/spike-tool-ref/spike.ts`, not committed): pi 1.4.0 with the faux
provider, an inline probe extension that appends `[tool-ref #N]`, and scripted assistant
turns. First run: trailer added in `tool_result`.

| Case | `tool_result` fires | Saved with trailer | Notes |
|---|---|---|---|
| Success (`bash`) | yes | yes | `durationMs` stored |
| Tool error (`read` of a missing file) | yes | yes | |
| `execute()` throws | yes | yes | Content is the error message |
| Tool throws on abort (running when aborted) | yes | yes | |
| Blocked by a `tool_call` handler | **no** | no | Content is the block reason |
| Unknown tool | **no** | no | "Tool X not found" |
| Invalid arguments | **no** | no | "Validation failed ..." |
| Length-cut turn (`stopReason: "length"`) | **no** | no | "Tool call ... was not executed" |
| Queued behind an abort (sequential) | — | — | No result message at all, also not after the next prompt |

Other results:

- The `tool_result` content replacement is what is saved and what the model gets.
- Parallel calls: numbers follow completion order (`throws` #1, `read` #2, `bash` #3 for
  calls made in the order bash, …, throws, …, read).
- A `message_end` handler that appends the trailer to `toolResult` messages without one
  fixes all four "no" cases: the replacement is saved, is in the agent context, and
  subscribers (the JSON stream) see it. `tool_execution_end` still has no trailer for them.

Second run: trailer added **only** in `message_end` (`role === "toolResult"`), no
`tool_result` hook. All eight cases with a result message got a trailer, saved and in the
agent context; numbers followed call order (#1–#7 for the seven calls of the first batch in
the order they were made, #8 for the aborted tool); `message_end` fired for roles `system`,
`user`, `assistant`, `toolResult`.

**Decision: number in `message_end` only** (see "Why `message_end` and not
`tool_result`"). Rejected: `tool_result` plus a `message_end` catch-up (two code paths,
completion order) and accepting the gap (blocked calls can be evidence).

## Tasks

All done with the implementation.

- **Load-order check: tool-ref last among `message_end` handlers that replace `toolResult`
  messages (pi-agent extensions only).** Same pattern as the scenario-profile/project check:
  every pi-agent extension with such a handler announces itself in its `session_start` on a
  shared channel (`TOOL_RESULT_REWRITER_CHANNEL` in `src/shared/protocol.ts`). tool-ref
  listens; an announcement after tool-ref's own `session_start` means that extension loaded
  after it: error entry (`pi-agent.error`) and shutdown, like the existing check. Today no
  pi-agent extension has such a handler, so the check guards future ones. Extensions outside
  this package are not checked. Test like `src/scenario-profile/load-order.test.ts`.
- **Load everywhere, last** (see "Where it loads"): manifest entry, runner `-e`, `build.mjs`
  entry, `--tools` allowlist.
- **Hide the trailer in the UI** (see "Display").
- **`report.json` `ref` field** (see "`report.json` tool log"), `parseHandle` in
  `src/shared/`, README update.

## Tests (plan)

- Trailer: added in `message_end` for `toolResult` only (other roles untouched), once as its
  own block, parsed back, `details` and other message fields preserved, images, empty
  content; a message that already has a trailer is not numbered again. Output that ends with a `[tool-ref #N]` line inside a
  larger text block is not parsed as a handle.
- Parsing guards: a trailer quoted in user/assistant/custom messages is ignored; a block
  appended after the trailer keeps the handle; two results claiming the same `N` (also on
  different branches) → `get` says ambiguous, `grep` shows `#?`; the counter scan still uses
  the max.
- Numbering: parallel results get distinct numbers; restart after reload continues from max;
  new branch after `/tree` continues from file max; a `toolResult` `message_end` before
  `session_start` (reload race) initializes lazily; a batch is numbered in call order; a number handed out by the old instance but not yet
  persisted is not reused by the new instance.
- Every result is numbered: excluded tools (default and from `toolRef.exclude`), tool-ref's
  own tools, and pi's own error results (blocked, unknown tool, invalid arguments,
  length-cut) get a trailer; nested calls do not.
- `get`: excluded handle → "excluded" error naming the tool; handle on an abandoned branch →
  "not on the active branch"; more than 10 refs → error; per-ref errors don't fail the other
  refs.
- Compaction: handle before `firstKeptEntryId` still resolves.
- `context_edit` replacement or omission: `get` and `grep` return the original content.
- `get` shaping: line ranges, negative ranges, char cap message; `lines` ignores input with
  `part: both`; multi-line input cut to one line in the header.
- `grep`: smart case; `in` input/output/both; `refs`, `tool`, `errors` filters; `context`
  lines; newest first; per-call and total caps with the "… N more" line; long lines cut
  around the match; excluded calls, other branches and images skipped; invalid pattern →
  error; `pattern: "."` with `in: "input"` lists calls.
- Guidance: in pi's `<rules>` without a scenario, in scenario-profile's `<rules>` with one
  (covered by `src/scenario-profile` tests); absent when `tool_ref_get` is not active.
- Results without a trailer are indexed by `toolCallId` only.
- Offline index from a JSONL file equals the live index (use `testdata/` recording), including
  a file whose last entry follows `/tree` navigation.
- Load order: done for scenario-profile/project (`load-order.test.ts`); tool-ref last among
  pi-agent `message_end` rewriters of `toolResult`: announcement after tool-ref's start →
  error and shutdown.
- Runner args: tool-ref is the last `-e`; `--tools` includes `tool_ref_get` and
  `tool_ref_grep` (`pi-command.test.ts`).
- Display: the wrapped `renderResult` and the fallback get content without the trailer; the
  session entry still has it.
- Tool log: `ref` taken from the `toolResult` `message_end` by `toolCallId` (also for
  blocked and length-cut calls); `output` has no trailer; `ref: null` without a trailer and
  for unfinished calls.

## Implementation notes

| Where | Decision |
|---|---|
| Files | `src/shared/tool-ref.ts` (`parseHandle`, tool names, used by the wrapper too), `src/tool-ref/resolver.ts` (`indexBranch`, `indexSessionFile`, `loadSettings`, `resolveHandle`), `format.ts` (get/grep text), `counter.ts`, `render.ts`, `index.ts` (extension) |
| Tool `details` | References, not full objects: `get` gives per ref `handle`, `toolCallId`, `toolName`, `isError`, `entryId` and the shown output range (or the error); `grep` the matching line numbers per call and what was left out. Full objects would copy every looked-up output into the session file again; other extensions use the resolver instead |
| `indexBranch` result | Also `refs` (branch order) and `fileHandles` (all handles in the file), so `get` can tell "not on the active branch" from "unknown"; `ambiguous` is a map handle → number of claims |
| `get` output | Header line, then `output (N lines):` or `output lines A-B of N:` and lines as `<n>  <text>`. `part: input`/`both` shows the input as in grep (`in:N` lines) without numbers. When `maxChars` cuts, the cut is at a line, and a tail request (`lines` starting negative) keeps the end |
| `grep` input lines | `bash` (only `command`): the command; other tools: one `key: value` per argument, strings raw (multi-line strings continue on the next lines), others as JSON. Context lines are marked `in-N`/`out-N` like `rg`, groups separated by `--` |
| `grep` without a usable handle | Results without a trailer (sessions from before tool-ref) are shown as `#?` like ambiguous ones, since they are still evidence |
| `tool` param of grep | An array of names; a single string is accepted (`prepareArguments`) |
| Fallback renderer | Added only for tools that are not built-in (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`). In interactive mode built-in tools always have renderers in `next()`; in the HTML export a fallback would replace the template's own drawing of them, so they show the trailer there. `next()` undefined is left to pi (trailer shown) |
| Tests | `src/tool-ref/session.test.ts` runs pi's SDK with the faux provider (the spike cases end to end, reload, resume, settings, guidance in `<rules>`) |
