# code-writer skills

Skills loaded only for the `code-writer` scenario (`src/shared/scenarios/code-writer.ts`).
This is a **scenario folder**: sandbox runs of other scenarios leave these skills out.

```
skills/code-writer/<skill>/SKILL.md     name: <skill>
```

- Keep the directory name equal to the skill's `name`. Names must be unique across shared,
  grouped and scenario skills (pi has no namespaces; on collisions it keeps the first one).
- Every subfolder here needs a `SKILL.md`, or the run stops as invalid input.
- Files directly in this folder (like this README) are ignored.
- Personal pi loads these too (through `package.json` → `pi.skills`), so say in `description`
  when a skill applies, so the model doesn't pick it for unrelated tasks.
