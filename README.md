# pi-agent

My pi resources and the sandbox agent runner, in one repo.

- `skills/`, `prompts/`: personal pi resources, loaded as a [pi package](https://pi.dev/packages)
  (`package.json` → `pi`).

## Use with personal pi

```sh
pi install ~/Project/pi-agent   # local path: loaded in place, edits apply on /reload
```

Never put `~/.pi/agent` itself under git: it mixes secrets (`auth.json`, `models.json` keys),
state (`sessions/`, `trust.json`, `models-store.json`) and downloaded binaries (`bin/`).
