# pi-agent docs

This pi install has the pi-agent package. It adds a few flags on top of stock pi.

## Topics

Print one with `pi --pi-agent-docs <topic>`:

- `project`: give the agent a project's rules, commands, workflows and docs (`--project`).
- `scenario`: run the agent in a fixed role, with its own prompt, tools and skills (`--scenario`).

## Flags

| Flag | Use it to |
|---|---|
| `--project <dir>` | Load the `project.yaml` in `<dir>` into the system prompt. |
| `--scenario <name>` | Use that scenario's system prompt, tools and skills. |
| `--tags <a,b>` | Tag the session (metadata only; the model never sees it). |
| `--pi-agent-docs [topic]` | Print these docs and exit. |

## Quick start

```sh
pi --pi-agent-docs scenario                                   # pick a scenario
pi -p --scenario code-writer --project ./my-project "Add a /healthz endpoint"
pi -p --scenario work-request-triage "$(cat request.txt)"
```

- Use `-p` (print mode) when you call pi from a script or another agent.
- Load the scenario before the project. The package already does this; if you pass `-e`
  flags yourself, list `scenario-profile` before `project`.
- A startup error is printed to stderr as `[pi-agent] <message>` and pi exits.
