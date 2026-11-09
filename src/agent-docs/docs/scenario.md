# Scenarios

A scenario is a fixed agent role. It sets the system prompt, the built-in tools, the rules and
the skills. Run one with `--scenario <name>`. Without `--scenario`, pi behaves as usual.

## Pick a scenario

- `code-writer`: write or change code and tests in the cwd. Use it for implementation tasks.
- `the-sculptor`: design partner. It discusses a problem and proposes solutions, may write
  design docs, and does not change code. Use it before you implement.
- `work-request-triage`: turn raw text (chat, email, ticket) into categorized tasks with
  extracted fields and open questions. Read-only. Pass the text as the message.
- `debugger`: investigate a bug: gather facts, or propose its potential root cause when asked.
  Reads the code, never changes it.
- `demo`: smoke test. It looks around the cwd and describes the project.

## Run

```sh
pi -p --scenario the-sculptor "How should scenarios share common rules?"
pi -p --scenario code-writer --project ./my-project "Fix the failing test in src/foo"
```

- An unknown name stops pi and lists the known names.
- Built-in tools are exactly the scenario's (table below). Tools from other extensions (MCP,
  personal) stay.
- Only shared skills and the scenario's own skills are loaded. Skills installed outside this
  package are left out unless the scenario includes them. A project's `skills.include` adds
  its skills on top.
- Combine it with `--project` to add project rules and commands on top.

## Results

In plain pi, a scenario only shapes the agent: there is no `submit_result` tool. The
structured result (`detailKind`, schema-checked `detail`) exists only in sandbox runs
(`pi-agent run --task task.json`, task `scenario` field), where it is written to `report.json`.
