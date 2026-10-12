# Design: project context and prompt-cache placement

> Status: **implemented** (see "Implementation notes").
> Based on pi `@earendil-works/pi-coding-agent` 1.0.4
> (`system-prompt.js`, `extensions.md`, the Anthropic provider) and the `cpa` provider in
> `config/models.json`.

## Goal

Give each run its project's rules, commands, workflows and docs, written by the user in one
manifest (`project.yaml`) and loaded by a pi extension, while keeping the prompt cache
effective:

- The system prompt, append prompt and skills stay byte-stable, so their cached prefix is reused
  across projects.
- Project content sits after them, stable for the whole session.
- The conversation only ever grows by appending.

Out of scope for now:

- How the project folder gets mounted was left open here; it is now set up in OpenShell as a
  read-only Docker volume mount (`openshell/README.md`, "Project folder").
- **Memory.** No memory store and no tool for the agent to save anything. All project context
  is written by the user; the agent only reads it. Memory may be designed later (see "Future").

## Cache background

- Anthropic caches by **exact prefix** over `tools → system → messages`. A cache marker stores
  the prefix up to that point; a later request reuses it if its own prefix is byte-identical.
- At most **4 markers** per request. A lookup checks about **20 blocks** back from each marker.
- Minimum cacheable size about 1–4k tokens (model-dependent). Lifetime 5 minutes, refreshed on
  every hit.
- Caches are separate per organization/API key, so all requests must reach the same upstream
  account. Today that holds: `cpa` has session affinity on and a single Claude account.
- pi sends a request on **every turn** (after each batch of tool calls), not only per user
  message. Within a run, gaps are usually seconds, so the 5-minute lifetime rarely expires.
- With `cpa` pricing (Sonnet 5.5: input $2/M, cache write $2.5/M, cache read $0.2/M), a cold
  start of a ~5k shared prefix costs about $0.01. On long runs the cost is dominated by
  re-reading the whole context each turn, so **context size matters more than prefix sharing**.

## pi today

```
[tools] ◆
[system: preamble → tool list → rules → docs → APPEND_SYSTEM → project_context (AGENTS.md)
         → skills → <cwd> → extension sections] ◆   (one text block)
[messages …] ◆                                       (marker on the last message)
```

With OAuth, pi adds a "You are Claude Code" system block with its own marker.

Two problems: pi's own `project_context` (AGENTS.md from the cwd and its parents) comes before
skills, so nothing from skills onwards is shared between projects; and the whole system prompt
is a single cached block, so there is no project-independent cache point inside it.

The wrapper already runs pi with `-na` (no context files, no project config), so
`project_context` is empty. Extension sections (`systemPromptOptions.sections`, one tag per key)
come after `<cwd>`, which is exactly where block B belongs.

## Layout

```
┌ Block A: shared by every project, for one scenario ───────────────────┐
│ tools: fixed for the whole run; submit_result is generic (done)        │
│ system: preamble, APPEND_SYSTEM, skills, <cwd> (/sandbox everywhere)   │
└──────────────────────────────────────────────────────────── ◆ marker ┘
┌ Block B: per project, fixed for the session ──────────────────────────┐
│ <project> <project_rules> <agents_md> <project_commands>               │
│ <project_cli_tools> <project_workflows> <project_docs>  ("Rendering")  │
└──────────────────────────────────────────────────────────── ◆ marker ┘
┌ Messages: append only ────────────────────────────────────────────────┐
│ task prompt                                                           │
│ result format: the scenario's detail schema, sent once (done)         │
│ turns…                                                                │
└────────────────────────────────────────────── ◆ marker (last message) ┘
```

Block B is the only place project context goes. Nothing is attached to tool results.

Marker budget: A, B, last message = 3. The marker after the tools is dropped (A covers tools +
A), and so is pi's OAuth marker. The fourth marker is kept free for a later "anchor" marker on
the previous request's last block (protects against the 20-block lookback on very wide turns;
deferred).

Tier sharing in practice: each scenario has its own tool list and system prompt, and tools come
first, so **block A is shared across projects within one scenario, not across scenarios**.
Accepted: smaller per-scenario skill menus likely help task quality more than the ~$0.01 per cold
start costs. Skills must not change during a run.

### Proxy cloaking (current OAuth subscription)

The `cpa` proxy (CLIProxyAPI) cloaks requests on OAuth accounts as Claude Code. In short: it
moves our system blocks after the first user message (the task), so block A is not shared across
runs; it replaces our cache markers with its own (forced 1h TTL, at most 4: sending A, B and last
message keeps all three); and the move causes one full cache write at turn 2. Within a run,
caching works normally.

Not a problem for now, and the design stays as is: it is built for a future API-key plan, where
the proxy does not cloak and the layout above is sent unchanged. (`"prompt_cache_options":
{"mode": "explicit"}` makes the proxy keep our markers even when cloaking.)

## Scenarios and projects

A scenario chooses the system prompt and the skills (plus its tools and result schema). A project
chooses rules, commands, workflows and docs. Neither refers to the other: `project.yaml` has no
scenario-specific sections.

## The project folder

```
/project/                      mounted read-only; the agent cannot change its own instructions
  project.yaml
  workflows/release.md
  workflows/payments-change.md
  docs/architecture.md
```

The workspace (code) is the cwd, `/sandbox`. Paths in `project.yaml` are relative to the folder
that contains it. The mount path appears in block B, so it must be the same on every run.

### `project.yaml`

```yaml
version: 1
name: billing-service
description: Payment and invoicing backend (Node 22, Postgres).

# Short, always-on rules, in this order.
rules:
  - Never commit to main; work on the current branch.
  - Do not add dependencies without saying why in the result.

# One-line invocations only; anything with more than one step is a workflow.
# Key = the exact command (quote it if it contains ": "), value = what it does.
commands:
  npm ci: Install dependencies from the lockfile.
  npm test: Run all unit tests.
  npm test -- --grep <pattern>: Run only the tests matching a pattern.

# General-purpose CLI tools the agent may use. Key = executable name, value = what it is for.
# The agent learns each one from its own help (`<tool> docs`, `<tool> skill`, `<tool> -h`).
cli_tools:
  synotool: Synology internal tooling (chat, deploy).

# Strictly step-by-step instructions for one specific task. Index only; read on demand.
# Guidance for one area of the code is a workflow too.
workflows:
  - path: workflows/release.md
    when: Cutting a release or bumping the version.
  - path: workflows/payments-change.md
    when: Changing anything under src/payments/.

# Reference material. Index only; read on demand.
docs:
  - path: docs/architecture.md
    when: Before changing module boundaries or adding a service.
```

`when` is written as a trigger: the condition under which the agent should read the file.

### `AGENTS.md`

Not part of the manifest. The extension reads `AGENTS.md` at the root of the workspace (cwd) if
it exists, and includes it in full. Only that one file: no parent folders, no subfolders, no
`CLAUDE.md`. It is read once at session start; edits the agent makes to it during the run show up
in the next session. It is included with or without a project manifest.

pi's own context-file loading stays off (`-na`), because it would place the file before skills
and also pick up parent folders.

In personal pi (the extension is in the package manifest) pi's context files may be on. With
`--project`, `before_agent_start` empties `systemPromptOptions.contextFiles` on every prompt, the
same effect as `-nc`. Without `--project`, if pi loaded any context files, the extension adds no
sections and skips the cache split, leaving pi's behavior unchanged.

### Rendering

Block B is a set of extension sections after `<cwd>`, in this order; pi wraps each in a tag of
the same name. Names are prefixed so they can't collide with pi's own sections (`rules`, `docs`).

```
<project>
name: billing-service
Payment and invoicing backend (Node 22, Postgres).
</project>

<project_rules>
- Never commit to main; work on the current branch.
- Do not add dependencies without saying why in the result.
</project_rules>

<agents_md>
path: /sandbox/AGENTS.md
…file content…
</agents_md>

<project_commands>
Run from /sandbox:
- `npm ci`: Install dependencies from the lockfile.
- `npm test`: Run all unit tests.
- `npm test -- --grep <pattern>`: Run only the tests matching a pattern.
</project_commands>

<project_cli_tools>
General-purpose CLI tools. Before using one, learn it from its own help: run `<tool> docs`, `<tool> skill` or `<tool> -h` (whichever it supports; subcommands may have their own) and follow it:
- `synotool`: Synology internal tooling (chat, deploy).
</project_cli_tools>

<project_workflows>
Before doing one of these tasks, read its file and follow the steps in order. If several apply, follow them one after another, finishing each before starting the next:
- /project/workflows/release.md: Cutting a release or bumping the version.
- /project/workflows/payments-change.md: Changing anything under src/payments/.
</project_workflows>

<project_docs>
Read every doc whose condition applies; a task can need several docs on different topics:
- /project/docs/architecture.md: Before changing module boundaries or adding a service.
</project_docs>
```

Rules for byte-identical output:

- Keep the manifest's order everywhere (lists and `commands` keys); never sort.
- Line endings become `\n`, trailing whitespace is trimmed, file content ends with exactly one
  newline. File content is otherwise included as written.
- No generated values in the text: no timestamps, sizes, hashes or counts.
- Empty or missing sections are left out.
- `report.json` records a hash of the rendered block B, so a changed prefix between runs of the
  same project is visible.

### Validation

TypeBox schema, strict:

- `version: 1`; `name` required; `description`, `rules`, `commands`, `cli_tools`, `workflows`,
  `docs` optional.
- Unknown keys are errors (a typo must not silently do nothing).
- Command keys and descriptions are single lines; `cli_tools` keys are one word (an executable).
- Every `workflows`/`docs` path must exist inside the project folder; no file listed twice.
- Warning (not error) when block B is over about 8k tokens: it is paid on every turn.

### Wiring

- `pi-agent run --project <dir>` (or `PI_AGENT_PROJECT`); the flag wins.
- Image: `docker/pi-agent.sh` defaults `PI_AGENT_PROJECT=/project`. Locally there is no default.
- The wrapper validates the manifest before starting pi and passes the folder to the extension
  with a pi flag.
  - Explicit `--project` with a missing or invalid manifest: exit 2 (bad input).
  - Default `/project` without `project.yaml`: run without project sections, with a warning in
    `report.json`.
  - Invalid manifest at the default path: exit 2.
- `src/shared/project.ts`: schema, loading and rendering, used by both the wrapper and the
  extension. YAML via the `yaml` package, bundled into both builds.

## Mechanisms (`src/project/` extension, `dist/project.js`)

| What | How |
|---|---|
| Block B | `before_agent_start`: load the manifest and `<cwd>/AGENTS.md` once per session, render, and set them as `systemPromptOptions.sections`. Edit sections only; returning a full `systemPrompt` would replace the prompt. The same sections on every prompt, so pi sends no delta |
| Split A / B | `before_provider_request`: split the system text before the first project section into two text blocks, each with a cache marker; remove the tools and OAuth markers to stay within 4 |
| Inspection | `/project` command: block B's sections with token estimates |
| Report | The wrapper renders block B with the same code and inputs; `report.json` `projectContext` has the sections, size and `sha256` |

## Stability rules

- Block A and B content must be **byte-identical** across runs: fixed ordering, no timestamps,
  run IDs, counters or machine-specific paths. Paths are the same in every sandbox
  (`/sandbox`, `/project`).
- Never rewrite block B mid-session. Anything that changes goes into a new message at the end.
- Keep the model and thinking level fixed during a run (each model has its own cache; changing
  thinking settings invalidates cached messages). Use subagents for cheaper work.
- Tool additions during a run are fine (pi adds them inline); removing or redefining tools is
  not.
- Compaction is the only planned point where the message prefix is rebuilt. Pruning old tool
  output, if added, happens in batches, never a little every turn.

## Already done

| Commit | Change |
|---|---|
| `bf7b9f4` | `submit_result` takes `{ summary, detail: object }` in every scenario; the scenario's detail schema is sent once as a message after the task and checked in `execute()` |
| `99f994f` | `config/settings.json`: the four 1M `cpa` models compact at ~200k tokens (`reserveTokens: 800000`) |
| `4a2d623` | `report.json` `metrics.cacheMisses`: requests that read under 95% of what the previous request cached |
| `657d66d` | `src/shared/project.ts`: manifest schema and loading, `AGENTS.md`, deterministic rendering |
| `fa56d80` | Project extension: block B sections, `/project` |
| `46ed6f2` | A/B split of the system prompt with cache markers |
| `29c5a75` | Wrapper `--project` / `PI_AGENT_PROJECT`, `report.json` `projectContext`, image default `/project` |

## Decisions

- **Manifest only.** Project context comes only from `project.yaml`; nothing is discovered by
  scanning folders. The project owner keeps the manifest up to date. The one fixed exception is
  `AGENTS.md` at the workspace root.
- **No scoped instructions.** Nothing is attached to tool results; area-specific guidance is a
  workflow.
- **Commands are one-liners** with a description; multi-step procedures are workflows.
- **Scenarios** choose the system prompt and skills only; projects don't vary by scenario.
- **Cache retention: 5 minutes** (pi's default). No 1-hour option planned.
- **No memory** for now.

## Future: memory

Not designed yet. The layout leaves room for it without changing the cache rules: a memory index
would go into block B as a snapshot taken at session start (like the docs index), and anything
saved during a run would only show up in the next session. Whether the agent may write memory
at all, and with what review, is part of that later design.

## Implementation notes

- **No reordering needed.** The wrapper already runs pi with `-na`/`-nc`, so pi's
  `project_context` is empty, and pi places extension sections after `<cwd>`. `<cwd>` therefore
  ends block A (it is `/sandbox` in every sandbox).
- **Two extensions.** The runner (`dist/extension.js`) and the project extension
  (`dist/project.js`) are separate; the wrapper always loads both, because `AGENTS.md` is used
  even without a manifest.
- **`--project` vs `PI_AGENT_PROJECT`.** The flag must point to a valid manifest (exit 2
  otherwise). The env var is a default: no `project.yaml` there means no project context and a
  warning; an invalid one is exit 2.
- **Split robustness.** The split looks for the exact rendered block B (preceded by pi's
  section separator) in the system text. If it isn't found (compaction summaries, a resumed
  session whose `AGENTS.md` changed so pi sent a delta, other APIs) or caching is off, the
  request is left as pi built it.
- **Bundling.** `yaml`'s Node entry is CommonJS, so both bundles get a `createRequire` banner.

## Verification

Done:

- Unit tests: manifest validation and error messages, rendering (golden output, byte-identical
  across loads), section order, the extension's sections and `/project`, the A/B split and marker
  placement for API-key and OAuth payloads, wrapper arguments and `projectContext`.
- Real pi 1.0.4: the request payload had two marked system blocks (A ending at `</cwd>`, B the
  project sections), no tool marker, and the marker on the last message.
- Real end-to-end run (demo scenario, Haiku): status `ok`; the `sha256` in `report.json` matched
  block B in pi's session file; the agent followed a project rule.
- Docker image in OpenShell (Sonnet 5.5, `--project /sandbox/examples/project` uploaded with the
  workspace): status `ok`; the agent read a doc from the block B index on its own; no cache
  misses. Without a project folder, the image default `/project` gives the warning and no
  project context.
- Read-only `/project` in OpenShell from a labeled Docker volume (`openshell/sync-project.sh`,
  `--driver-config-json` mount, `/project` in the image policy): writes fail, a run without
  `--project` uses it and the agent reads its docs, an unlabeled volume is refused.

Not done yet:

- Cache regression run: two projects × one scenario back to back, on an API-key upstream (the
  current OAuth proxy rearranges the prompt). On the second run's first request, `cacheRead`
  must be at least block A's size; `cacheMisses` must be empty outside compactions.
