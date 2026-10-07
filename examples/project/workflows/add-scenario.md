# Add a scenario

1. Create `src/shared/scenarios/<name>.ts` with `defineScenario({ ... })`: `name`, `detailKind`
   (`<name>/v1`), `systemPrompt`, `tools`, optional `skillPaths`, and a TypeBox object
   `detailSchema`.
2. Register it in `src/shared/scenarios/index.ts` (add it to the `registry` list).
3. If it needs skills, put them in `skills/<name>/` and list them in `skillPaths` (relative to
   the repo root).
4. When changing an existing scenario's `detailSchema`, bump the version in `detailKind`
   (`<name>/v2`).
5. Add or update tests next to the code (`*.test.ts`).
6. Run `npm run check`; it must pass.
7. Add a task file for the scenario and do one real run with `npm run dev -- run --task <file>`.
