#!/bin/sh
# Copies a project folder (project.yaml + workflows/docs) into the pi-projects Docker volume as
# <name>/, so sandboxes can mount it read-only at /project:
#
#   openshell/sync-project.sh examples/project pi-agent
#   openshell sandbox create ... --driver-config-json \
#     '{"docker":{"mounts":[{"type":"volume","source":"pi-projects","subpath":"pi-agent","target":"/project","read_only":true}]}}'
#
# Creates the volume (with OpenShell's approval labels for the workspace) if it doesn't exist.
# Replaces <name>/ completely; run it between runs, not while a sandbox uses that project.
# The copy runs in the pi-agent image (already local), as root, so files end up root-owned and
# world-readable: the sandbox user can read them, never write them.
set -eu

volume=${PI_PROJECTS_VOLUME:-pi-projects}
image=${PI_AGENT_IMAGE:-pi-agent:local}
workspace=${OPENSHELL_WORKSPACE:-default}

if [ $# -ne 2 ]; then
  echo "usage: $0 <project-dir> <name>" >&2
  exit 2
fi
src=$(cd "$1" && pwd)
name=$2
case $name in
  "" | */* | .*) echo "invalid name '$name': one folder name, not starting with a dot" >&2; exit 2 ;;
esac
if [ ! -f "$src/project.yaml" ]; then
  echo "$src/project.yaml not found" >&2
  exit 2
fi

if ! docker volume inspect "$volume" >/dev/null 2>&1; then
  docker volume create \
    --label openshell.ai/sandbox-attachable=true \
    --label "openshell.ai/sandbox-attachable-workspace=$workspace" \
    "$volume" >/dev/null
  echo "created volume $volume (workspace $workspace)"
fi

docker run --rm --user root --entrypoint sh \
  -v "$volume":/v -v "$src":/src:ro "$image" -c "
    set -e
    rm -rf '/v/$name'
    mkdir '/v/$name'
    cp -R /src/. '/v/$name/'
    chown -R root:root '/v/$name'
    chmod -R u=rwX,go=rX '/v/$name'
    find '/v/$name' -type f | sed 's|^/v/||'
  "
echo "synced $src -> $volume/$name"
