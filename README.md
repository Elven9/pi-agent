# pi-agent

My pi resources and the sandbox agent runner, in one repo.

| Path | What |
|---|---|
| `skills/` | Shared (`skills/<skill>/`, grouped `skills/<group>/<skill>/`) and scenario (`skills/<scenario>/<skill>/`) skills for runs; also a pi package resource |
| `prompts/` | Personal pi prompt templates, loaded as a pi package (`package.json` → `pi`) |
| `src/shared/` | Task, scenarios, result envelope, `report.json` contract, wrapper↔extension protocol |
| `src/extension/` | pi extension (runner only): `submit_result`, one resubmit nudge |
| `src/scenario-profile/` | pi extension: `--scenario <name>` applies the scenario's system prompt, tools and skills (runner and personal pi) |
| `src/metrics/` | pi extension: session metrics as `pi-agent.metrics` entries in the session file (runner and personal pi) |
| `src/session-upload/` | pi extension (personal pi only): uploads the raw session file to a session server |
| `src/project/` | pi extension: project context (`project.yaml` + `AGENTS.md`) in the system prompt, cache split |
| `src/tool-ref/` | pi extension: a handle (`[tool-ref #N]`) on every tool result, `tool_ref_get` / `tool_ref_grep` to look calls up (runner and personal pi) |
| `src/wrapper/` | `pi-agent run`: starts the stock pi CLI in JSON mode, writes `report.json` |
| `examples/` | Example task file and project folder (`project/`: `project.yaml`, a workflow, a doc) |
| `testdata/` | Recorded pi run + `fake-pi.mjs` for wrapper tests |
| `Dockerfile`, `docker/`, `openshell/`, `config/` | Sandbox image and OpenShell setup |
| `docs/cli-vs-sdk-decision.md` | Why the CLI and not the SDK (from agents-core) |
| `docs/project-context-design.md` | Project context and prompt-cache placement |
| `docs/tool-ref-design.md` | Tool-call handles (`tool-ref`) |

## Personal pi

```sh
pi install ~/Project/pi-agent   # local path: loaded in place, edits apply on /reload
```

The manifest exposes `skills/`, `prompts/*.md` and these extensions: project context
(`src/project/`), context view (`src/context-view/`), session metrics (`src/metrics/`), session
upload (`src/session-upload/`) and tool-ref (`src/tool-ref/`, listed last), loaded from source,
and the scenario profile, loaded from `dist/scenario-profile.js` because
scenarios import their prompts as `.md`, which pi's loader can't import. Run `npm run build`
after cloning and after changing a scenario. Not the runner extension.

```sh
pi --scenario work-request-triage   # that scenario's system prompt, tools and skills
```

The scenario's prompt replaces pi's default preamble (appended prompts, context files, skills
and project context still follow). Built-in tools are exactly the scenario's; tools from other
extensions (MCP, personal) stay. Skills of other scenarios (`skills/<other>/`) are left out of
the prompt; shared, grouped and skills from outside this package stay. There is no
`submit_result` and no instruction to call it: both come from the runner extension. Without
`--scenario` the extension does nothing.

```sh
pi --project ~/path/to/project-folder   # project.yaml + workspace AGENTS.md; pi's context files off
pi                                      # extension stays out of the way: pi's own AGENTS.md handling
```

With `--project`, the extension drops pi's context files (AGENTS.md/CLAUDE.md from the agent
dir, cwd and parents) from every prompt, as `-nc` would, and adds only the workspace AGENTS.md
in its own section. Startup still lists them under `[Context]`; `/project` shows what is
actually sent. Without `--project` it adds nothing while pi loads context files itself.

### Session upload

Off unless `~/.pi/agent/extensions/session-upload.json` exists (global only, so a repo can't
redirect uploads):

```json
{
  "machineId": "macbook-retro9",
  "endpoint": "https://sessions.example.com",
  "headers": { "CF-Access-Client-Id": "$CF_ACCESS_CLIENT_ID", "CF-Access-Client-Secret": "${CF_ACCESS_CLIENT_SECRET}" }
}
```

It sends the raw session file as `PUT <endpoint>/sessions/<machineId>/<sessionId>`
(`Content-Type: application/x-ndjson`); the server replaces what it has. `headers` are optional;
a value of `$NAME`/`${NAME}` comes from that environment variable. When: `/upload` (with a
notification), and on `/quit`, `/new`, `/resume` and `/fork` for the session being left
(failures go to stderr; `/reload` does not upload). Before each upload the metrics extension
appends its latest totals, so the file ends with them. A session with no file yet is skipped;
the timeout is 15 s, no retry. A crashed session is not uploaded; its file stays on disk.
Sandbox runs never load it (`-ne`): the orchestrator uploads the session and report.

### Tool references

The tool-ref extension (`src/tool-ref/`, design in `docs/tool-ref-design.md`) appends
`[tool-ref #N]` as an extra text block to every tool result, so the model can cite calls by
number. Numbers are unique per session file. `tool_ref_get` shows results by handle (`lines`
for a range, `part: input|both`), `tool_ref_grep` finds calls by regex over input and output
(`pattern: ".", in: "input"` lists them). Both read the raw session entries of the active
branch, so compaction does not hide anything. The interactive UI hides the trailer; the session
file keeps it.

`toolRef.exclude` in `settings.json` (global or project; a project list replaces the global one)
names tools whose results the two tools won't show; default `["submit_result"]`. Excluded
calls are still numbered. Read at session start (`/reload` applies a change).

Never put
`~/.pi/agent` itself under git: it mixes secrets (`auth.json`, `models.json` keys), state
(`sessions/`, `trust.json`, `models-store.json`) and downloaded binaries (`bin/`).

## Runner

```sh
npm install
npm run check                      # typecheck + tests + build
npm start -- run --task task.json [--workdir <dir>] [--out <dir>] [--resume <session.jsonl>] [--project <dir>]
npm run dev -- run --task …        # same, from the .ts sources (no build)
```

`npm start`/`npm run dev` use the pinned pi from `node_modules/.bin`; elsewhere `pi` must be on
`PATH` (or set `PI_AGENT_PI_BIN`). Models, credentials and settings come from the pi agent dir
(`~/.pi/agent`, or `PI_CODING_AGENT_DIR`). The image copies `config/models.json` and
`config/settings.json` there; locally, merge `config/settings.json` into your own
`settings.json` to get the same behavior.

`config/settings.json` makes the 1M-context models compact at about 200k tokens
(`reserveTokens: 800000`) instead of near the window limit. Every turn re-reads the whole context
from the prompt cache, so a smaller context is cheaper per turn, and long contexts also hurt
quality.

| Arg | Default | Purpose |
|---|---|---|
| `--task` | required | Task file (see below) |
| `--workdir` | current folder | pi's cwd: where tools run and the agent's work products go |
| `--out` | `<workdir>/.agent-out` | Report and session files (add to `.gitignore`) |
| `--resume` | none | Previous session file to continue from (`pi --fork`) |
| `--project` | `PI_AGENT_PROJECT` (image: `/project`) | Folder with `project.yaml` (see "Project context") |

| Exit | Meaning |
|---|---|
| `0` | `report.json` written (even if `status` is `error` or `no_result`) |
| `1` | Wrapper itself crashed; no reliable report |
| `2` | Invalid input (bad args, unknown scenario, unreadable task or resume file, invalid or missing `project.yaml`) |

Progress goes to stderr, including the exact `pi` command line (re-run it to debug). stdout
gets only the report path. SIGINT/SIGTERM stop pi (whole process group) and still write a report.

### How a run works

```
pi-agent run ──spawn──▶ pi --mode json -ne -e dist/extension.js -e dist/scenario-profile.js -e dist/project.js -e dist/metrics.js -e dist/tool-ref.js
     ▲                    │    --scenario <name> [--project <dir>] … -- <prompt>
     │                    │  scenario-profile: owns --scenario; system prompt, tools, skills
     │                    │  extension: submit_result + instruction, nudge once
     │                    │  project:   project sections in the system prompt, cache split
     │                    │  metrics:   pi-agent.metrics entry at every settle
     │                    │  tool-ref:  [tool-ref #N] on every tool result, tool_ref_get/grep (last)
     └──── JSONL events ──┘  (stdout, read continuously; split on LF only)
```

The wrapper loads nothing implicitly: no discovered extensions, skills, prompt templates,
context files, MCP or project config (`-na`: the workdir is not trusted). The scenario decides
the system prompt and tools, the `skills/` layout its skills (shared + the scenario's, one
`--skill` each); the project extension adds the project context. The scenario profile
extension sets the system prompt and applies the tools and skills in-process, as in personal
pi; `--tools` and `--skill` stay as the hard limits. It announces the scenario on the
`pi-agent.scenario` `pi.events` channel, and the runner extension registers `submit_result`
then (pi rejects a flag registered by two extensions).

Everything in the report comes from pi's event stream, timed by the wrapper as records arrive:
the result (`details` of the last successful `submit_result`), the final model error, tokens and
cost (assistant messages + compactions), turns, model latency/TTFT, tool calls and durations,
retries and compactions, and `cacheMisses`: requests that read under 95% of what the previous
request had cached (not checked for the first request or right after a compaction). The context
peak comes from the metrics extension's `pi-agent.metrics` entry, because pi does not stream
context usage. The session file under `<out>/sessions/` is the full record.

### Session metrics (`pi-agent.metrics` entries)

The metrics extension (`src/metrics/`) runs the same `MetricsCollector` inside pi, in sandbox
runs and in personal pi, and writes its totals into the session file as `custom` entries (not
model context): at every settle (once per prompt), on session shutdown (`/quit`, `/new`,
`/resume`, `/fork`, `/reload`) if anything changed, and when another extension asks for it
(`pi.events` channel `pi-agent.metrics.flush`, e.g. before an upload). Data: the report's
`metrics` without `wallMs`, `phases` and `retries` (wrapper-only), plus `version: 1` and
`samples`, the raw TTFT, latency and tool durations since the previous entry.

The metrics are cumulative for the session branch: on start the extension continues from the
branch's earlier entries, so the newest entry is the total across resumes (and, for a runner
`--resume`, includes the earlier run; report.json covers only the current run except for
`contextPeakPercent`). Percentiles are recomputed from all `samples`; the cache-miss check
starts over after a resume.

### Task file

```jsonc
{
  "taskId": "t-123",
  "scenario": "demo",               // registered scenario name
  "prompt": "…",
  "model": "cpa/claude-sonnet-5-5", // optional, "provider/id"; default from pi settings
  "thinkingLevel": "medium"         // optional: off | minimal | low | medium | high | xhigh | max
}
```

### Outputs

```
<out>/
  sessions/<timestamp>_<id>.jsonl   pi session (debugging and resuming)
  report.json                       written last, atomically = "done" marker
```

`report.json` has `status` (`ok | error | no_result`), `result` (`summary`, `detailKind`,
scenario-specific `detail`), `metrics`, `projectContext`, `toolCalls`, `session` (paths
relative to `out`), `errors` and `warnings`. A stale `report.json` is removed when a run starts.

`status` is `error` when pi cannot start, exits nonzero, stops before the agent starts, the
final model response failed and there is no result, or the result fails validation. Otherwise
it is `ok` with a valid result and `no_result` without one.

`toolCalls` lists every tool call in start order: `id`, `tool`, `turn`, `startedAt`,
`durationMs`, `isError`, `args` and text `output` (images become `[image]`). Strings in `args`
are cut at 1000 chars and `output` at 2000, with `truncated: true`.

### Scenarios

A scenario is a profile (system prompt, tools, skills) plus a TypeBox `detail` object schema, in
`src/shared/scenarios/`. `submit_result` has the same parameters in every scenario (`summary` +
any `detail` object), because tool definitions start the cached prompt prefix. The extension
sends the detail schema once as a message after the task prompt (`pi-agent.result-format`) and
validates `detail` in the tool, so an invalid call fails and the model can retry; the wrapper
checks the result again. It also adds one line to every scenario's system prompt, as pi's
append prompt (the `<addendum>` right after the scenario prompt): "When you are done, call the
submit_result tool exactly once with your final result." (`SUBMIT_INSTRUCTION`), so scenario
prompts don't mention `submit_result`. Without a valid call the agent is
nudged once, then the status is `no_result`. `submit_result` ends the run (`terminate: true`),
which saves a model request.

To add one, write the system prompt in `src/shared/scenarios/prompts/<name>.md` (without the
submit instruction), create
`src/shared/scenarios/<name>.ts` with `defineScenario({...})` (`import systemPrompt from
"./prompts/<name>.md"`) and register it in `src/shared/scenarios/index.ts`. esbuild inlines the
Markdown into the bundles (`loader: { ".md": "text" }`), so `dist/` needs no `.md` files; tests and
`npm run dev` load `.md` imports through `scripts/md-loader.mjs`. Version `detailKind` (`<name>/v1`) and bump it when `detail`
changes.

Skills are picked by folder, not listed in the scenario:

```
skills/<skill>/SKILL.md              shared: loaded for every scenario
skills/<group>/<skill>/SKILL.md      shared too; <group> is listed in SKILL_GROUPS (e.g. synology)
skills/<scenario>/<skill>/SKILL.md   loaded only for that scenario
```

The wrapper resolves them at startup (`src/wrapper/skills.ts`): shared skills first, then the
scenario's, each sorted by folder name, so the skills part of the cached prompt stays stable.
A top-level folder that is neither a skill, a group nor a registered scenario, a group or
scenario subfolder without `SKILL.md`, or two skills with the same folder name stop the run as invalid input (exit
2); a test checks the repo's layout. Paths are absolute, under the app root
(`/usr/local/lib/pi-agent/skills` in the image), so nothing is written to the workdir.

`projectContext` is null without project context, otherwise the project folder and name (null
with only `AGENTS.md`), the section names, size (`chars`, `approxTokens`) and the `sha256` of the
rendered block. If the hash differs between two runs of the same project, so did the cached
prompt prefix.

### Project context

The project extension (`dist/project.js`) adds a project's context to the end of the system
prompt, after the scenario's prompt and skills, as "block B". Design and reasons:
`docs/project-context-design.md`. It has two sources, both read once at session start:

- `project.yaml` in the `--project` folder (in the image: `/project`, mounted read-only). Only
  what the manifest lists is used; nothing is discovered by scanning folders.
- `AGENTS.md` at the root of the workspace, if it exists (no parent folders, no subfolders).

```yaml
version: 1
name: billing-service
description: Payment and invoicing backend (Node 22, Postgres).
rules:                       # short, always-on rules
  - Never commit to main; work on the current branch.
commands:                    # one-line invocations only: exact command → what it does
  npm test: Run all unit tests.
cli_tools:                   # general-purpose tools: executable → what it is for
  synotool: Synology internal tooling (chat, deploy).
workflows:                   # step-by-step instructions for one task each; read on demand
  - path: workflows/release.md
    when: Cutting a release or bumping the version.
docs:                        # reference material; read on demand
  - path: docs/architecture.md
    when: Before changing module boundaries.
```

`examples/project/` is a complete example (for this repo), with a workflow and a doc. Paths
are relative to the manifest's folder. Unknown keys, multi-line commands, tool names with
spaces, and missing, duplicate or outside paths are errors. Sections in the prompt, in order:
`<project>`, `<project_rules>`, `<agents_md>`, `<project_commands>`, `<project_cli_tools>`,
`<project_workflows>`, `<project_docs>`; workflows and docs are listed as `path: when`, not
included. `<project_cli_tools>` tells the agent to learn each tool from its own help (`<tool>
docs`, `<tool> skill` or `<tool> -h`) before using it; the tools must be installed where the
agent runs (for sandbox runs: in the image). The rendering is deterministic
(manifest order, normalized text), so the same files give the same bytes and the cached prefix
carries over between runs. Keep the folder at the same path on every run: paths are part of the
text.

The extension also splits the system prompt into two cached blocks, A (prompt, skills, cwd) and
B (project), so A's cache is shared across projects. On an OAuth account the `cpa` proxy
rearranges the prompt and markers anyway (see the design doc).

Locally, try it with `npm run dev -- run --task task.json --project <dir>`; in an interactive
pi, `pi -e dist/project.js --project <dir> -nc` and `/project` shows the sections and sizes.

### Resuming in a fresh sandbox

`--resume` runs `pi --fork <file>`: the new session file under `<out>/sessions` copies the
previous transcript, and the stream (so the metrics) holds only this run. The session holds
only the transcript, not the files: restoring the workdir is up to the orchestrator. Use the
same workdir path as the previous run, because the transcript contains absolute paths; the
wrapper warns if it differs.

## Updating pi

The extension API, the JSON event shapes and the session format are pi library contracts, so pi
is pinned in three places: `package.json` (devDependency), `Dockerfile` (`PI_VERSION`) and the
recorded fixture. To update:

1. Bump the version in `package.json` and `Dockerfile`, `npm install`, read pi's changelog.
2. Re-record `testdata/demo-run.*`: run the demo task with `PI_AGENT_PI_BIN` pointing at a script
   that tees pi's stdout to `testdata/demo-run.events.jsonl`, and copy the session file to
   `testdata/demo-run.session.jsonl`. Update the expected values in `src/wrapper/run.test.ts`.
3. `npm run check`, then one real run per scenario.

Docker and OpenShell: see `openshell/README.md`.
