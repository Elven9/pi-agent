# Decision: move agents-core from the pi SDK to CLI + extension

> Copied from `~/Project/agents-core` (abandoned). This repo is the replacement. Where the
> implementation differs from the plan below, see "Implementation notes" at the end.

> Based on pi `@earendil-works/pi-coding-agent` 1.0.2 docs (`cli.md`, `cli-integration.md`,
> `extensions.md`, `json.md`, `session-format.md`) and the code in this repo as of commit
> `03158f2`. Follow-up to `~/Project/agent-system-survey/pi-cli-vs-sdk-in-openshell.md`.

## Decision

This repo (SDK runner) is abandoned. The replacement runs the stock `pi` CLI in the sandbox with
one custom extension, plus a thin wrapper that builds the command line and turns the session
file into `report.json`.

## Why the SDK is not needed

The survey lists six reasons to pick the SDK. This repo uses only one: structured output with
a retry (`submit_result` + re-prompt once). In pi 1.0.2 an extension can do that too:
`agent_before_settle` can return `continue: true` to ask for one more model turn.

There are no mid-run tool or prompt changes, no computed profiles, one agent per sandbox, no
in-process state shared between agents, and no custom session control beyond fork.

## Feature mapping

| Feature now (SDK) | CLI + extension + session parsing |
|---|---|
| Scenario profile (`session.ts`) | Flags: `--system-prompt`, `--tools`, `-ns --skill`, `-nc`, `-np`, `-ne -e ./agents-core.ts`, `--model`, `--thinking` |
| `submit_result` checked against the scenario's TypeBox schema | `pi.registerTool()` in the extension. Pick the scenario with a flag added via `pi.registerFlag("scenario")` |
| Re-prompt once if there is no result | `agent_before_settle` returns `continue: true` (guarded so it fires only once) |
| Get the result | Saved in the tool result's `details` in the session file; the wrapper parses it |
| `--out/sessions`, `--resume` (fork) | `--session-dir`, `--fork <path>` (`--session-id` to choose the new ID) |
| `checkResume` (cwd check) | Wrapper reads the session file header (`cwd`) |
| Model error → `status: error` | Last assistant message's `stopReason` in the session file. **In `--mode json` a failed response does not cause a nonzero exit code** |
| Tokens and cost | Add up `usage` from assistant messages plus `usage` and `compaction` entries (what `getSessionStats()` does now) |
| Turns, tool calls, tool errors, compactions | Can be rebuilt from the session file |
| Full tool args and output | In the session file, without truncation |
| **TTFT, model latency, tool `startedAt`/`durationMs`, peak context %, retry count** | **Not in the session file** (messages only have end timestamps; no tool start times or stream timing). Collect them in the extension via `pi.on("turn_start" / "message_update" / "message_end" / "tool_execution_*" / "auto_retry_start" / "compaction_end")` and `ctx.getContextUsage()`. Save them with `pi.appendEntry("agents-core.metrics", …)` |
| Atomic `report.json`, exit codes 0/1/2 | Wrapper: run `pi`, then parse the session file and write the report. A wrapper is required anyway because nothing inside pi can write the report if pi crashes |
| `AGENTS_CORE_MODELS_PATH` | The CLI reads `models.json` from `PI_CODING_AGENT_DIR`; I found no separate env setting for the path. The entry script copies it into `/tmp/pi-agent/` |

Code moves rather than disappears. `result.ts`, `metrics.ts` and `tool-log.ts` (event part)
become the extension. `session.ts` and most of `runner.ts` become the wrapper.

## Things to watch

1. **The CLI loads more by default than the SDK setup did.** The SDK runner turned off
   extensions, context files, prompt templates and skills. The CLI also loads built-in codemode,
   tool_search and MCP, plus trust-gated project config from the workdir. Run with:
   ```sh
   pi --mode json -ne -e ./agents-core.ts --no-mcp -ns -nc -np -na --offline ...
   ```
   `-na` matters most because `/sandbox` holds code we don't trust.
2. **Still tied to a pi version.** The extension API (`ExtensionAPI`, event shapes,
   `agent_before_settle`) is a library API too, and the wrapper depends on the session file
   format. Pin the pi version and keep the session parser covered by tests.
3. **Still a custom image.** fd, ripgrep, `models.json`, the wrapper and the extension still
   have to be in it. "Stock pi image" from the survey does not apply.
4. **Extension dependencies.** pi loads the extension at runtime (via `jiti`), so imports
   such as `typebox` must resolve in the image. Either ship a pre-built JS file or install the
   dependencies next to the extension.
5. **Read stdout continuously** if the wrapper consumes `--mode json`. Split records on LF only;
   don't use Node `readline` (see `json.md`). Progress for humans goes to stderr.

## What we gain and lose

- Gain: debug by re-running the exact `pi` command; any language for the wrapper; pi's own
  session handling, fork and built-ins are available if we enable them.
- Lose: in-process typed results and events; one process instead of two (wrapper + pi).
- About the same: amount of code to maintain, image work, coupling to pi versions.

## When to go back to the SDK

Any of these: multi-phase runs that change tools or the prompt mid-task, subagents or several
agents per sandbox, profiles computed at runtime, or in-process state shared between agents.

## Carry over from this repo

- `report.json` contract (`reportVersion`, `status`, `result`, `metrics`, `toolCalls`,
  `session`, `errors`, `warnings`), written last and atomically as the "done" marker.
- Scenario = profile + versioned `detailKind` + TypeBox `detail` schema.
- Docker/OpenShell setup: `/usr/local/lib/...` app path, env defaults set in the entry script
  (OpenShell ignores image `ENV`), `PI_CODING_AGENT_DIR=/tmp/pi-agent`, provider placeholders
  for `$CPA_*` (`openshell/`).
- Unit tests for metrics percentiles, tool log pairing by `toolCallId`, and resume checks.
