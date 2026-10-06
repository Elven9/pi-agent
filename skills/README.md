# Skills

One directory per skill, each with a `SKILL.md` (see pi's `docs/skills.md`). Keep the
directory name equal to the skill's `name` so other Agent Skills tools accept it too.

```
skills/<name>/SKILL.md
skills/<name>/references/…   optional files the skill points to (relative paths)
```

Loaded by personal pi through the package manifest (`package.json` → `pi.skills`). Sandbox runs
never load them implicitly: a scenario lists the skills it wants (`skillPaths`).
