# Running pi-agent in OpenShell

The image ships `config/models.json` with `$CPA_*` env references instead of secrets. In the
sandbox those env vars hold opaque placeholders (`openshell:…`). The OpenShell proxy swaps in
the real values only on requests to `cpa.mysecretbase.win` (see `provider-cpa.yaml`), so the
agent (and its `bash` tool) never sees them.

Requirements: Docker Engine >= 28 and, on Docker Desktop, *Settings → Resources → Network →
Enable host networking* (the sandbox supervisor reaches the gateway on host loopback).

```sh
# Once: register the provider profile and store the credentials in the gateway
openshell profile lint   -f openshell/provider-cpa.yaml
openshell profile import -f openshell/provider-cpa.yaml
CPA_API_KEY=... CPA_CF_ACCESS_CLIENT_ID=... CPA_CF_ACCESS_CLIENT_SECRET=... \
  openshell provider create --name cpa --type cpa --from-existing

# Build with the engine the gateway uses (push to a registry if the gateway is remote)
docker build -t pi-agent:local .

# Once per project change: copy the project folder into the pi-projects volume (see below)
openshell/sync-project.sh examples/project pi-agent

# Per task. `create --upload` can't be combined with a trailing command yet, so the sandbox
# idles on `sleep infinity` and the run happens via exec. The mount puts the project at
# /project (read-only), the wrapper's default.
openshell sandbox create --name t-123 --from pi-agent:local --provider cpa \
  --driver-config-json '{"docker":{"mounts":[{"type":"volume","source":"pi-projects","subpath":"pi-agent","target":"/project","read_only":true}]}}' \
  --detach -- sleep infinity
openshell sandbox upload t-123 . /sandbox                  # .gitignore filtering applies
openshell sandbox exec -n t-123 --no-login-shell --timeout 0 -- \
  pi-agent run --task /sandbox/examples/task.example.json --out /sandbox/.agent-out
openshell sandbox download t-123 /sandbox/.agent-out ./openshell-out  # source must be inside /sandbox
openshell sandbox delete t-123
```

Image layout and why:

| Path | Purpose |
|---|---|
| `/sandbox` | Workspace (`WORKDIR`; OpenShell uses `/sandbox` on Podman/K8s/MicroVM anyway) |
| `/project` | Project folder (`project.yaml`, workflows, docs), meant to be mounted read-only. Default of `PI_AGENT_PROJECT`; without a `project.yaml` the run has no project context (warning in the report). See "Project folder" |
| `/usr/local/lib/pi-agent` | `dist/pi-agent.js` (wrapper), `dist/extension.js`, `skills/` (shared and per scenario), `config/models.json`, `config/settings.json`. Under `/usr` because the default filesystem policy only allows reads from `/usr`, `/lib`, `/etc`, ... |
| `/usr/local/bin/pi` | Stock pi CLI (`npm install -g`, version pinned by the `PI_VERSION` build arg) |
| `/usr/local/bin/pi-agent` | Wrapper (`docker/pi-agent.sh`). Sets env defaults (`PI_CODING_AGENT_DIR=/tmp/pi-agent`, `PI_AGENT_MODELS` and `PI_AGENT_SETTINGS` (copied to the agent dir), `PI_AGENT_PROJECT=/project`, `PI_OFFLINE`, ...) because OpenShell starts processes with a clean env and ignores image `ENV` |
| `/etc/openshell/policy.yaml` | Sandbox policy (`openshell/policy.yaml`), used when a sandbox is created without `--policy`. Read-only: `/usr`, `/bin`, `/lib`, `/etc`, `/proc`, `/dev/urandom`, `/project`; read-write: the workspace, `/tmp`, `/dev/null`; everything else (e.g. `/home`) is inaccessible. Landlock is required (`hard_requirement`). No network rules: the `cpa` provider adds the only one |
| `/tmp/pi-agent` | pi agent dir: must be writable (auth lock, catalog cache); default policy allows `/tmp` |

Debugging: `openshell policy get <name> --full` shows the effective policy, and
`openshell logs <name>` shows allowed and denied network requests.

## Project folder

The project folder (`project.yaml`, workflows, docs; see `docs/project-context-design.md`) is
mounted read-only at `/project` from a Docker volume. Each project is a subfolder of the
`pi-projects` volume, and a sandbox mounts only its own (`subpath`).

Setup, once per gateway:

1. Allow driver config in the gateway TOML (Homebrew: `/opt/homebrew/var/openshell/gateway.toml`),
   then `brew services restart openshell`:

   ```toml
   [openshell.drivers.docker]
   allow_driver_config = true
   ```

   Resource admission stays on: only volumes with OpenShell's approval labels can be mounted,
   and host bind mounts (including bind-backed volumes) stay disabled.
2. `openshell/sync-project.sh <project-dir> <name>` creates the `pi-projects` volume with the
   labels (`openshell.ai/sandbox-attachable=true`,
   `openshell.ai/sandbox-attachable-workspace=default`) and copies the folder into `<name>/`,
   root-owned and world-readable. Run it again after changing the project, between runs.

Per sandbox, add the mount shown at the top (`subpath` = the project name). Inside, `/project`
is read-only twice: the Docker mount is `ro`, and the image policy (`openshell/policy.yaml`)
lists it under `read_only`. The policy only takes effect at sandbox start, which is why
`sandbox upload` can't fill `/project` instead.

Checked: the sandbox user can list and read `/project` but not create, change, delete or chmod
anything (`Read-only file system`); a run without `--project` uses it (`projectContext.dir:
"/project"`, no warning) and the agent reads `/project/docs/...` from the index; a volume
without the labels is refused (`external resource not admitted by required labels`).

Without the mount, a run still works: it warns and has no project context. To use a project
anyway, upload it with the workspace and pass `--project /sandbox/<path>` (writable by the
agent, and its paths in the prompt differ from `/project`).
