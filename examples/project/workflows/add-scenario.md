# Add a scenario

1. Write the system prompt in `src/shared/scenarios/prompts/<name>.md`. Don't tell the model to
   call `submit_result`: the runner adds that line to every scenario's prompt.
2. Create `src/shared/scenarios/<name>.ts` with `defineScenario({ ... })`: `name`, `detailKind`
   (`<name>/v1`), `systemPrompt` (`import systemPrompt from "./prompts/<name>.md"`), `tools`, and
   a TypeBox object `detailSchema`. Register it in `src/shared/scenarios/index.ts` (add it to
   the `registry` list).
3. If it needs its own skills, put them in `skills/<name>/<skill>/SKILL.md`; they are loaded
   automatically, together with the shared `skills/<skill>/`. Skill folder names must be unique.
   Skills installed outside this package (e.g. `~/.agents/skills/agent-browser`) are excluded
   unless listed by name in `externalSkills.include` (see `skills/README.md`).
4. When changing an existing scenario's `detailSchema`, bump the version in `detailKind`
   (`<name>/v2`).
5. Add or update tests next to the code (`*.test.ts`).
6. Run `npm run check`; it must pass.
7. Add a task file for the scenario and do one real run with `npm run dev -- run --task <file>`.
