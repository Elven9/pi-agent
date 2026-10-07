# Skills

One directory per skill, each with a `SKILL.md` (see pi's `docs/skills.md`). Keep the
directory name equal to the skill's `name` so other Agent Skills tools accept it too.

```
skills/<skill>/SKILL.md                shared skill: loaded for every scenario
skills/<skill>/references/…            optional files the skill points to (relative paths)
skills/<scenario>/<skill>/SKILL.md     scenario skill: loaded only for that scenario
```

`<scenario>` is a registered scenario name (`src/shared/scenarios/`). Any other top-level folder
without a `SKILL.md` is an error, and skill folder names must be unique across shared and
scenario skills. Files directly in `skills/` or `skills/<scenario>/` (like this README) are
ignored.

Sandbox runs load the shared skills plus the scenario's, nothing else (`src/wrapper/skills.ts`).
Personal pi loads all of them through the package manifest (`package.json` → `pi.skills`).
