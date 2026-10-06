# pi-agent

My pi resources and the sandbox agent runner, in one repo.

| Path | What |
|---|---|
| `skills/`, `prompts/` | Personal pi resources, loaded as a pi package (`package.json` → `pi`) |
| `src/shared/` | Task, scenarios, result envelope, `report.json` contract, wrapper↔extension protocol |
| `src/extension/` | pi extension: `submit_result`, one resubmit nudge, context-usage peak |
| `src/wrapper/` | `pi-agent run`: starts the stock pi CLI in JSON mode, writes `report.json` |
| `testdata/` | Recorded pi run + `fake-pi.mjs` for wrapper tests |
| `Dockerfile`, `docker/`, `openshell/`, `config/` | Sandbox image and OpenShell setup |
| `docs/cli-vs-sdk-decision.md` | Why the CLI and not the SDK (from agents-core) |

## Personal pi

```sh
pi install ~/Project/pi-agent   # local path: loaded in place, edits apply on /reload
```

The manifest exposes `skills/` and `prompts/*.md` only, not the runner extension. Never put
`~/.pi/agent` itself under git: it mixes secrets (`auth.json`, `models.json` keys), state
(`sessions/`, `trust.json`, `models-store.json`) and downloaded binaries (`bin/`).

## Runner

```sh
npm install
npm run check                      # typecheck + tests + build
npm start -- run --task task.json [--workdir <dir>] [--out <dir>] [--resume <session.jsonl>]
npm run dev -- run --task …        # same, from the .ts sources (no build)
```

`npm start`/`npm run dev` use the pinned pi from `node_modules/.bin`; elsewhere `pi` must be on
`PATH` (or set `PI_AGENT_PI_BIN`). Models and credentials come from the pi agent dir
(`~/.pi/agent`, or `PI_CODING_AGENT_DIR`).

| Arg | Default | Purpose |
|---|---|---|
| `--task` | required | Task file (see below) |
| `--workdir` | current folder | pi's cwd: where tools run and the agent's work products go |
| `--out` | `<workdir>/.agent-out` | Report and session files (add to `.gitignore`) |
| `--resume` | none | Previous session file to continue from (`pi --fork`) |

| Exit | Meaning |
|---|---|
| `0` | `report.json` written (even if `status` is `error` or `no_result`) |
| `1` | Wrapper itself crashed; no reliable report |
| `2` | Invalid input (bad args, unknown scenario, unreadable task or resume file) |

Progress goes to stderr, including the exact `pi` command line (re-run it to debug). stdout
gets only the report path. SIGINT/SIGTERM stop pi (whole process group) and still write a report.

### How a run works

```
pi-agent run ──spawn──▶ pi --mode json -ne -e dist/extension.js --scenario <name> … -- <prompt>
     ▲                    │  extension: submit_result, nudge once, pi-agent.metrics entry
     └──── JSONL events ──┘  (stdout, read continuously; split on LF only)
```

The wrapper loads nothing implicitly: no discovered extensions, skills, prompt templates,
context files, MCP or project config (`-na`: the workdir is not trusted). The scenario decides
the system prompt, tools and skills.

Everything in the report comes from pi's event stream, timed by the wrapper as records arrive:
the result (`details` of the last successful `submit_result`), the final model error, tokens and
cost (assistant messages + compactions), turns, model latency/TTFT, tool calls and durations,
retries and compactions. The context peak comes from the extension's `pi-agent.metrics` entry,
because pi does not stream context usage. The session file under `<out>/sessions/` is the full
record.

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
scenario-specific `detail`), `metrics`, `toolCalls`, `session` (paths relative to `out`),
`errors` and `warnings`. A stale `report.json` is removed when a run starts.

`status` is `error` when pi cannot start, exits nonzero, stops before the agent starts, the
final model response failed and there is no result, or the result fails validation. Otherwise
it is `ok` with a valid result and `no_result` without one.

`toolCalls` lists every tool call in start order: `id`, `tool`, `turn`, `startedAt`,
`durationMs`, `isError`, `args` and text `output` (images become `[image]`). Strings in `args`
are cut at 1000 chars and `output` at 2000, with `truncated: true`.

### Scenarios

A scenario is a profile (system prompt, tools, skills) plus a TypeBox `detail` schema, in
`src/shared/scenarios/`. The extension builds `submit_result` from `summary` + that schema, so pi
validates the arguments; the wrapper checks the result again. Without a valid call the agent is
nudged once, then the status is `no_result`. `submit_result` ends the run (`terminate: true`),
which saves a model request.

To add one, create `src/shared/scenarios/<name>.ts` with `defineScenario({...})` and register it
in `src/shared/scenarios/index.ts`. Version `detailKind` (`<name>/v1`) and bump it when `detail`
changes. Scenario skills go in `skills/<name>/` and are listed in `skillPaths` (relative to the
repo root, which is also the app root in the image).

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
