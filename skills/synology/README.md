# Synology skills

Shared skills for work at Synology, grouped here for organization. This is a **skill group**,
not a scenario: sandbox runs load these skills for every scenario, like top-level shared skills
(see `SKILL_GROUPS` in `src/wrapper/skills.ts`).

```
skills/synology/synology-<topic>/SKILL.md     name: synology-<topic>
```

- Prefix every skill with `synology-`. Pi has no skill namespaces and the folder doesn't count:
  the frontmatter `name` is the only identity, and on name collisions pi keeps the first one.
- Keep the directory name equal to `name`, and say in `description` that the skill is for
  Synology work so the model doesn't pick it for unrelated tasks.
- This repo may be public: no secrets, internal hostnames, credentials or customer data.

## Loading only at work (personal pi)

Turn the group off globally with a glob, so skills added later are covered too
(`~/.pi/agent/settings.json`):

```json
{ "packages": [{ "source": "/path/to/pi-agent", "skills": ["!skills/synology/**"] }] }
```

Then, in a work repo, run `pi config --local` and set the skills you need to `+`.

### How global and project scope interact

- **Global** (`~/.pi/agent/settings.json`, `pi config`): applies everywhere. Each skill is on or off.
- **Project** (`.pi/settings.json`, `pi config --local`): applies only in that repo, and only
  after you trust the project.
- Pi matches the same package across both scopes (npm name, git URL, or absolute local path).
- A project entry normally **replaces** the global one for that package.
- `pi config --local` writes `"autoload": false`, which makes the project entry a **delta** over
  the global one. A skill you don't mention keeps its global state, `+path` forces it on, and
  `-path` forces it off. In the TUI, Space cycles inherit → `-` → `+`.
- Relative `source` paths in `.pi/settings.json` resolve from that file, so moving the repo or
  the package breaks the link.
