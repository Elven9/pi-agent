# Design: tool-call references (`tool-ref` extension)

> Status: **design**, not implemented.
> Based on pi `@earendil-works/pi-coding-agent` 1.4.0 (repo pin and global install):
> `docs/extensions.md`, `docs/session-format.md`, `docs/compaction.md`, `docs/settings.md`,
> `dist/core/extensions/runner.js` (`emitToolResult`), the bundled `AgentSession`
> (`_afterToolCall`), `dist/core/session-manager.d.ts` and `dist/core/settings-schema.js`.
> Still verify the points marked "verify" at runtime before implementing.

## Goal

Give every tool call in a session a short, stable number that the model can cite and look up
cheaply. Reports built later on top of this (experiment blocks, result system) store these
numbers instead of copying commands and output, so they record exactly what ran and cost few
tokens.

The extension provides:

1. A **handle** (`#12`) added to every tool result as it is created.
2. `tool_ref_get`: one or more results by handle, with range and grep to keep output small.
3. `tool_ref_list`: a compact index of tool calls on the active branch, with filters.
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
- **Searching compaction summaries** in `tool_ref_list`.

## Rules

| # | Rule |
|---|---|
| R1 | Handles are positive integers, unique **within one session file**, assigned in the order results are created. |
| R2 | The handle is stored **in the tool result content** (trailer text block). That persisted content is the only source of truth; no side table. |
| R3 | Only the **active branch** is visible. `get` and `list` never return calls from abandoned branches. |
| R4 | Data is read from **raw session entries**, never from the model context, so compaction and `context_edit` do not hide anything from the resolver. |
| R5 | The extension never changes what a tool returned, other than appending the trailer. |

## Handle trailer

Appended by a `tool_result` handler as one extra text block at the end of `content`:

```
[tool-ref #12]
```

- The trailer is **its own content block**, never merged into the tool's text. Parsing: the
  **last** content block is a text block whose whole text matches `^\[tool-ref #(\d+)\]$`.
  Text that only *ends* with such a line (e.g. `cat` of this doc or of a session file) does
  not match.
- Image-only and empty results get the text block too.
- Remaining collision: a tool whose output is exactly one text block `[tool-ref #N]` **and**
  whose trailer was removed by a later handler would be misread. Accepted as theoretical. At
  worst it raises the counter at `session_start` (harmless: numbers only need to be unique).
- About 6 tokens per call. The model sees the number right after the output it belongs to.
- Prompt cache: the trailer is added before the result is first persisted and sent, so the
  message never changes afterward.

### Why the content and not `details` or a custom entry

| Option | Problem |
|---|---|
| Merge into the tool's `details` | `details` belongs to each tool (renderers, the runner's `submit_result`, the todo example read their own shape). Adding keys risks breaking them. |
| `pi.appendEntry()` custom entry mapping handle → toolCallId | A second record that can drift from the first. Ordering against the result entry under parallel calls is unclear. More to rebuild. |
| **Trailer in content** | What the model saw and what the resolver reads are the same bytes. Survives reload and resume. No extra state. |

### Which calls get a handle

| Call | Handle | Why |
|---|---|---|
| Top-level tool calls, success **and error** | yes | Failed attempts are evidence in experiments |
| Nested calls (`parentToolCallId` set, e.g. from codemode) | no | Out of scope for v1 (see above); skip any event with `parentToolCallId` |
| `tool_ref_get`, `tool_ref_list` | no | Looking things up is not evidence; avoids handles pointing at handles |
| Tools in `toolRef.exclude` (default `submit_result`) | no | Plumbing tools; also hidden from `list` and `get` |

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

- `exclude`: tool names that get no trailer and are skipped by the index. Default
  `["submit_result"]` when the key is missing. `tool_ref_get` / `tool_ref_list` are always
  excluded and need not be listed.
- Read at `session_start`, so a change applies after `/reload`.
- Verify: unknown keys survive the merge and pi's settings writes (e.g. `/settings` changes
  must not drop `toolRef`); project settings only apply to trusted projects.

Verify: whether `tool_result` fires for calls **blocked** by a `tool_call` handler, for
calls whose `execute()` throws, and for synthetic results of aborted or length-cut turns. Each
case either gets a handle or is listed as a known gap.

### Assigning numbers

- `session_start` (every reason: startup, reload, new, resume, fork): scan
  `ctx.sessionManager.getEntries()` (**whole file**, all branches) for trailers and set
  `next = max + 1`, or 1 for a new session.
- Verify: no `tool_result` can be in flight across a reload, i.e. a result numbered before
  the reload but persisted after the rescan would let the same number be given out twice. If
  it can happen, also count numbers handed out in memory and keep `next = max(scan, memory)`.
- `tool_result`: take `next++` **synchronously, before any `await`**. Parallel calls then
  get distinct numbers; their order follows result-handler order, not call order. That is
  acceptable: numbers identify calls, they don't order them.
- Numbering is **per file, not per branch**. After `/tree`, a new branch continues after the
  highest number in the file, so a number never means two different calls in one file, even
  across branches. R3 still decides visibility.

### Interplay with other `tool_result` handlers

pi's `emitToolResult` runs handlers in extension load order; each sees earlier changes.

- Replacing `content` makes pi **drop `structuredContent`** unless the handler returns it
  too. The handler must return `structuredContent: event.structuredContent` unchanged.
- A later handler that replaces `content` (e.g. a redaction extension) can remove the trailer.
  Load `tool-ref` **last**, or such handlers must keep the last block. Calls without a
  trailer have no handle and are only reachable by `toolCallId` (see the resolver).

## Resolving a handle

The resolver walks `ctx.sessionManager.getBranch()` once and builds, per handle:

| Field | Source |
|---|---|
| `handle` | trailer of the `toolResult` message |
| `toolCallId`, `toolName`, `isError` | `toolResult` message |
| `input` | the matching `toolCall` block (same id) in the preceding assistant message on the branch |
| `output` | `toolResult` content without the trailer; images as `[image]` |
| `startedAt`, `endedAt` | assistant message timestamp, tool result timestamp (an approximation; pi stores no duration) |
| `entryId` | session entry id of the tool result |
| `edited` | true if a `context_edit` on the branch replaces this entry's content for the model (e.g. a failed attempt shortened to a note). The raw content stays the source; the replacement may no longer contain the trailer, so the model may not see the handle any more |
| `editedPreview` | first line of the replacement content, so the model knows what it was shown instead |
| `compacted` | true if the entry sits before the latest compaction's `firstKeptEntryId` (the model only has a summary of it) |

Indexing is linear in branch length. Sessions are thousands of entries at most, so rebuild on
each lookup. Cache by `getLeafId()` only if that turns out to be slow.

Tool results without a trailer (from a tool not in `exclude`, e.g. a later handler removed it)
are indexed by `toolCallId` only. Results of excluded tools are not indexed.

A handle not on the active branch is an error that says so ("#12 is not on the active
branch"), not "unknown", so the model doesn't search for it.

## Tools

Both tools are read-only (`annotations.readOnlyHint: true`), `exposure: "direct"`, and
return compact text for the model plus `details` with the full objects for renderers and
other extensions.

### `tool_ref_list`

Purpose: find calls cheaply, especially ones the model no longer sees after compaction.

| Param | Meaning |
|---|---|
| `tool` | filter by tool name(s) |
| `errors` | only failed / only successful |
| `query` | substring (case-insensitive) in input or output |
| `since`, `until` | handle range |
| `limit` | default 50, newest first or oldest first (`order`) |

One line per call, e.g.:

```
#3  bash ok  ~ make build                             → 12 lines, "ok"
#12 bash ok    npm test -- auth                       → 41 lines, "PASS src/auth.test.ts"
#13 read ok  e src/auth/session.ts                    → 210 lines
#14 bash ERR   apfs-fuse /dev/sdb2 /mnt/mac           → 3 lines, "apfs-fuse: no such device"
… 3 more (use since/until)
```

The flag column marks each row: `~` compacted (the model only has a summary), `e` edited by
`context_edit`. A one-line legend is printed only when a flag appears. Calls without a
trailer show `id:<toolCallId>` instead of a handle.

The summary column is a per-tool one-line form of the input (`bash`: command, `read`/`edit`/
`write`: path, others: shortened JSON), plus output line count and first non-empty line.
Lines are shortened to a fixed width.

### `tool_ref_get`

| Param | Meaning |
|---|---|
| `refs` | one or more handles (`[12, 14]`); batch to save round trips |
| `part` | `output` (default), `input`, or `both` |
| `lines` | line range of the **output**, e.g. `[1, 80]` or `[-50, -1]` for the tail |
| `grep` | regex over the **output**; return matching lines with `context` lines around them, line numbers kept |
| `maxChars` | per-ref cap, default ~4000; the result says what was cut and how to get the rest |

`lines` and `grep` apply to the output only; with `part: both` the input is shown whole
(it is short; capped by `maxChars` like everything else).

Output starts with a header per ref (`#14 bash ERR · input: apfs-fuse …`) and keeps original
line numbers so later calls can request exact ranges.

### Prompt guidance (tool `promptGuidelines`)

Text:

- Every tool result ends with `[tool-ref #N]`. Cite evidence by number, not by copying output.
- To see earlier results again, use `tool_ref_get` with `grep` or `lines` instead of re-running
  the command.
- After context was summarized, use `tool_ref_list` to find older calls.

Where: `promptGuidelines` of `tool_ref_get` (all three lines on one tool, so they appear
once). pi renders tool guidelines in `<rules>`, only while the tool is active.

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
relies on scenario-profile loading before the project extension (true for the runner and the
package manifest); otherwise `<rules>` follows the project sections and lands in block B.

Rules:

- **Constant text.** No counts, dates or session data, so it never changes within a session
  (pi sends no prompt delta) or across sessions (block A cache stays valid).
- Under `--scenario`, `<rules>` holds the guidelines of every active extension tool, so its
  text is shared only by setups with the same extension tools.

## Resolver module (for other extensions)

Exported functions, no pi state of their own, so the report system and tests use them directly:

- `parseHandle(content) → number | undefined`
- `indexBranch(entries) → Map<number, ToolRef>` (plus lookup by `toolCallId` for calls
  without a trailer)
- `formatList(refs, filters)`, `formatGet(ref, options)`
- `loadSettings(settings) → { exclude: string[] }` (defaults applied); `indexBranch` takes
  the exclude list so live and offline indexes agree

Live data comes from `ctx.sessionManager`; offline data (uploaded session files) from parsing
JSONL and walking `parentId` from the last entry to get the same branch. One code path for both.

## Branches

- **Rule:** only the active branch counts. A report or a citation made on a branch that was
  later abandoned is abandoned with it.
- Consequence for later consumers: anything that caches "the calls of this session" must
  rebuild on `session_tree`. The tools here don't cache, so nothing to do.
- Numbering stays file-wide (see above), so returning to an old branch never makes an old
  citation point at a different call.

## Compaction

- Handles survive in the raw entries; resolving is unaffected (R4).
- The model loses sight of older handles. `tool_ref_list` (with `compacted` markers) is the
  way back.
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

## Modes

No UI needed; works in interactive, print, JSON and RPC modes. The runner's `report.json`
tool log (`src/wrapper/tool-log.ts`) will show the trailer in `output`, which links report
entries to handles.

## Open items

- Checked in 1.4.0 source: `structuredContent` drop rule (`runner.js` `emitToolResult`),
  `parentToolCallId` on nested call events, `context_edit` is a content replacement
  (`ContextEditEntry.replacement`), settings accept extra keys.
- Verify at runtime: `tool_result` content replacement is what gets persisted.
- Verify the edge cases under "Which calls get a handle", the reload race under "Assigning
  numbers", and the settings points under "Settings".
- Exact output caps and line width for `list`/`get`, after trying on real sessions.

## Tests (plan)

- Trailer: appended once as its own block, parsed back, `structuredContent` and `details`
  preserved, images, empty content. Output that ends with a `[tool-ref #N]` line inside a
  larger text block is not parsed as a handle.
- Numbering: parallel results get distinct numbers; restart after reload continues from max;
  new branch after `/tree` continues from file max.
- Visibility: handle on an abandoned branch → "not on the active branch".
- Compaction: handle before `firstKeptEntryId` resolves and is marked `compacted`.
- `context_edit` replacement → `edited` with `editedPreview`; `e` flag in `list`.
- `get` shaping: line ranges, negative ranges, grep with context, char cap message; `lines`/
  `grep` ignore input with `part: both`.
- Guidance: in pi's `<rules>` without a scenario, in scenario-profile's `<rules>` with one
  (covered by `src/scenario-profile` tests); absent when `tool_ref_get` is not active.
- Excluded tools (default and from `toolRef.exclude`) and nested calls get no trailer and do
  not appear in `list`.
- Results without a trailer are listed as `id:<toolCallId>`.
- Offline index from a JSONL file equals the live index (use `testdata/` recording).
