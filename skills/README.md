# Skills

One directory per skill, each with a `SKILL.md` (see pi's `docs/skills.md`). Keep the
directory name equal to the skill's `name` so other Agent Skills tools accept it too.

```
skills/<skill>/SKILL.md                shared skill: loaded for every scenario
skills/<skill>/references/…            optional files the skill points to (relative paths)
skills/<group>/<skill>/SKILL.md        grouped skill: shared, only organized in a folder
skills/<scenario>/<skill>/SKILL.md     scenario skill: loaded only for that scenario
```

`<group>` is listed in `SKILL_GROUPS` (`src/wrapper/skills.ts`), e.g. `synology/`; prefix its
skill names with the group (`synology-deploy`), since pi has no skill namespaces. `<scenario>` is
a registered scenario name (`src/shared/scenarios/`). Any other top-level folder without a
`SKILL.md` is an error, and skill folder names must be unique across shared, grouped and
scenario skills. Files directly in `skills/`, `skills/<group>/` or `skills/<scenario>/` (like
this README) are ignored.

Sandbox runs load the shared skills plus the scenario's, nothing else (`src/wrapper/skills.ts`).
Personal pi loads all of them through the package manifest (`package.json` → `pi.skills`).

## External skills

Skills installed on the machine outside this package (`<agent dir>/skills`, `~/.agents/skills`)
are excluded by default under a scenario, in sandbox runs and in personal pi with `--scenario`.
A scenario opts in by skill name:

```ts
defineScenario({ name: "code-writer", /* … */ externalSkills: { include: ["agent-browser"] } });
```

Included skills are loaded when installed (sandbox runs: `--skill`; personal pi: kept in the
prompt, or added if pi's settings turned them off); not installed ones are ignored. Without
`--scenario`, personal pi loads whatever pi's settings say. This package's own skills are not
affected (`src/shared/external-skills.ts`).
