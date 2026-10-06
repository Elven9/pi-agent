#!/bin/sh
# Wrapper entry point inside the image. OpenShell starts processes with its own clean
# environment (the image's ENV is not inherited), so the defaults live here, not in ENV.
# Anything already set in the environment wins.
#
# - PI_CODING_AGENT_DIR: must be writable (auth.json lock, catalog cache); OpenShell's default
#   policy only allows /tmp and the workdir.
# - PI_AGENT_MODELS: read-only models.json with $CPA_* references; in OpenShell those env vars
#   are placeholders the proxy swaps for the real secrets. The pi CLI only reads models.json
#   from the agent dir, so it is copied there.
# - PI_OFFLINE etc.: the sandbox blocks pi.dev anyway; don't try.
: "${NODE_ENV:=production}"
: "${PI_CODING_AGENT_DIR:=/tmp/pi-agent}"
: "${PI_AGENT_MODELS:=/usr/local/lib/pi-agent/config/models.json}"
: "${PI_OFFLINE:=1}"
: "${PI_SKIP_VERSION_CHECK:=1}"
: "${PI_TELEMETRY:=0}"
export NODE_ENV PI_CODING_AGENT_DIR PI_OFFLINE PI_SKIP_VERSION_CHECK PI_TELEMETRY

mkdir -p "$PI_CODING_AGENT_DIR" || exit 1
if [ -f "$PI_AGENT_MODELS" ]; then
  cp "$PI_AGENT_MODELS" "$PI_CODING_AGENT_DIR/models.json" || exit 1
fi

exec node /usr/local/lib/pi-agent/dist/pi-agent.js "$@"
