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

# Per task. `create --upload` can't be combined with a trailing command yet, so the sandbox
# idles on `sleep infinity` and the run happens via exec.
openshell sandbox create --name t-123 --from pi-agent:local --provider cpa --detach -- sleep infinity
openshell sandbox upload t-123 . /sandbox                  # .gitignore filtering applies
openshell sandbox exec -n t-123 --no-login-shell --timeout 0 -- \
  pi-agent run --task /sandbox/examples/task.example.json --out /sandbox/.agent-out \
  --project /sandbox/examples/project                      # see "Project folder" below
openshell sandbox download t-123 /sandbox/.agent-out ./openshell-out  # source must be inside /sandbox
openshell sandbox delete t-123
```

Image layout and why:

| Path | Purpose |
|---|---|
| `/sandbox` | Workspace (`WORKDIR`; OpenShell uses `/sandbox` on Podman/K8s/MicroVM anyway) |
| `/project` | Project folder (`project.yaml`, workflows, docs), meant to be mounted read-only. Default of `PI_AGENT_PROJECT`; without a `project.yaml` the run has no project context (warning in the report). Not set up yet: see "Project folder" |
| `/usr/local/lib/pi-agent` | `dist/pi-agent.js` (wrapper), `dist/extension.js`, scenario `skills/`, `config/models.json`, `config/settings.json`. Under `/usr` because the default filesystem policy only allows reads from `/usr`, `/lib`, `/etc`, ... |
| `/usr/local/bin/pi` | Stock pi CLI (`npm install -g`, version pinned by the `PI_VERSION` build arg) |
| `/usr/local/bin/pi-agent` | Wrapper (`docker/pi-agent.sh`). Sets env defaults (`PI_CODING_AGENT_DIR=/tmp/pi-agent`, `PI_AGENT_MODELS` and `PI_AGENT_SETTINGS` (copied to the agent dir), `PI_AGENT_PROJECT=/project`, `PI_OFFLINE`, ...) because OpenShell starts processes with a clean env and ignores image `ENV` |
| `/etc/openshell/policy.yaml` | Sandbox policy (`openshell/policy.yaml`), used when a sandbox is created without `--policy`. Read-only: `/usr`, `/bin`, `/lib`, `/etc`, `/proc`, `/dev/urandom`, `/project`; read-write: the workspace, `/tmp`, `/dev/null`; everything else (e.g. `/home`) is inaccessible. Landlock is required (`hard_requirement`). No network rules: the `cpa` provider adds the only one |
| `/tmp/pi-agent` | pi agent dir: must be writable (auth lock, catalog cache); default policy allows `/tmp` |

Debugging: `openshell policy get <name> --full` shows the effective policy, and
`openshell logs <name>` shows allowed and denied network requests.

## Project folder

The design (`docs/project-context-design.md`) mounts the project folder read-only at `/project`.
That is not set up yet, because OpenShell can't do it with defaults:

- The filesystem policy only takes effect at sandbox start, and paths it doesn't list are
  inaccessible. The image's policy (`openshell/policy.yaml`) already lists `/project`
  read-only; without a mount the path is simply skipped.
- `sandbox upload` runs as the sandbox user under that policy, so it can't create `/project`
  or write into a read-only path.
- Real mounts go through `--driver-config-json` (Docker: `{"docker":{"mounts":[…]}}`), which
  the gateway disables by default. It needs `allow_driver_config = true` in the Docker driver
  config and a Docker volume labeled `openshell.ai/sandbox-attachable=true` (bind mounts also
  need `enable_bind_mounts` and admission turned off).

Until then, upload the project folder with the workspace and pass it explicitly
(`--project /sandbox/examples/project` above). That works, but the folder is writable by the
agent and its paths in the prompt differ from `/project`.
