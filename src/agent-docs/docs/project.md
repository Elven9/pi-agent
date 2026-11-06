# Project context

A project is a folder with a `project.yaml`. With a project, the agent gets the project's
description, rules, commands, CLI tools and an index of its workflows and docs in its system
prompt. It reads a workflow or doc file only when the task matches.

## Use a project

```sh
pi --project ./path/to/project-folder          # this run only
```

Or set it once in `settings.json` (`~/.pi/agent/settings.json` or `.pi/settings.json`):

```json
"project": { "type": "local", "dir": "/abs/path/to/project-folder" }
"project": { "type": "github", "repo": "https://github.com/org/repo", "tag": "v1.2.0", "path": "projects/billing" }
```

- `--project` wins over the settings entry.
- A relative `dir` is resolved against the cwd pi runs in, not the settings file. `~` is not
  expanded.
- `github` / `gitlab` read the repo at the tag through the logged-in `gh` / `glab` (nothing is
  cloned). The agent then reads workflows and docs with the `project_read` tool.
- With a project, pi's own AGENTS.md/CLAUDE.md discovery is turned off. The `AGENTS.md` files
  of the cwd and every parent folder (up to `/`) are added instead, outermost first.

## Write project.yaml

```yaml
version: 1
name: billing
description: |
  What the project is, in two or three lines.
rules:                       # short, always on, in order
  - Run `just check` before you finish.
cli_tools:                   # executable -> what it is for (must be installed)
  gh: GitHub issues and PRs
workflows:                   # step-by-step for one task each; read on demand
  - path: workflows/release.md
    when: Cutting a release.
docs:                        # reference material; read on demand
  - path: docs/architecture.md
    when: Before changing module boundaries.
skills:                      # skills for this project, by skill name
  include: [golang, agent-browser]
```

- Only these keys are allowed; any other key is an error.
- Paths are relative to the project folder, and every listed file must exist.
- Write `when` as the trigger for reading the file, not as a summary of it.
- Keep rules short. Move detail into a workflow or doc. The whole project section is re-sent
  every turn.

## Skills

- `skills.include` lists skills by name (frontmatter `name`, else the folder name).
- Without `--scenario`, only the listed skills are active. With a scenario, they are added to
  the scenario's skills.
- Names are looked up in pi-agent's own skills (any of them), then `~/.pi/agent/skills` and
  `~/.agents/skills`. A name that is not installed is skipped with a warning.
- Without the `skills` key the project does not change the skills; `include: []` means none.
- The startup hint lists the active skills.

## Commands

Commands are `just` recipes, not `project.yaml` entries:

- Put a `justfile` next to `project.yaml` and/or in the workspace root. If both have a recipe
  with the same name, the workspace's wins.
- The agent runs `just <recipe>` from any folder. Recipes always run in the workspace.
- A recipe's doc comment (`# ...` above it) is shown to the agent, so write it as the usage.

## Check it

- In the TUI, run `/project` to see the sections that are sent and their sizes.
- If `project.yaml` is invalid or missing, or a justfile can't be read, pi prints
  `[pi-agent] <message>` and stops.
