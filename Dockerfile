# syntax=docker/dockerfile:1

# Keep these in sync with .nvmrc and the pi devDependency in package.json (the extension, the
# session parser and the test fixtures are tied to that pi version).
ARG NODE_VERSION=26.10.0
ARG PI_VERSION=1.4.0
# just runs the project commands (justfile recipes, see README "Project commands").
ARG JUST_VERSION=1.59.0

# ---- build: bundle the wrapper and the extension ----
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json build.mjs ./
COPY src ./src
# No source maps in the image: they embed the full TypeScript sources.
RUN PI_AGENT_SOURCEMAP=0 npm run build

# ---- just: release binary, checked against the release's SHA256SUMS ----
FROM node:${NODE_VERSION}-bookworm-slim AS just
ARG JUST_VERSION
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && case "${TARGETARCH:-amd64}" in amd64) arch=x86_64 ;; arm64) arch=aarch64 ;; *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; esac \
 && file="just-${JUST_VERSION}-${arch}-unknown-linux-musl.tar.gz" \
 && url="https://github.com/casey/just/releases/download/${JUST_VERSION}" \
 && cd /tmp \
 && curl -fsSLO "${url}/${file}" \
 && curl -fsSL "${url}/SHA256SUMS" | grep "  ${file}\$" | sha256sum -c - \
 && tar -xzf "${file}" just \
 && install -m 755 just /usr/local/bin/just

# ---- runtime: node + stock pi CLI + two bundled files ----
FROM node:${NODE_VERSION}-bookworm-slim
ARG PI_VERSION
# The agent's bash tool runs commands in the workdir. pi uses fd and ripgrep for file search
# and would otherwise download them on first use, which the OpenShell sandbox blocks.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates fd-find git ripgrep \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

COPY --from=just /usr/local/bin/just /usr/local/bin/just

# pi installs its own dependencies (typebox included, which the extension uses).
RUN npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && npm cache clean --force

# The app lives under /usr because OpenShell's default filesystem policy only allows reads
# from /usr, /lib, /etc, ... (not /app). No node_modules: both bundles are self-contained.
WORKDIR /usr/local/lib/pi-agent
COPY --from=build /app/dist ./dist
COPY config/models.json config/settings.json ./config/
# Skills: shared skills/<skill>/ and skills/<group>/<skill>/, scenario skills/<scenario>/<skill>/, resolved by the wrapper per run.
COPY skills ./skills

# OpenShell runs commands via exec, not the ENTRYPOINT, so put the wrapper on PATH.
# Runtime env defaults are set in docker/pi-agent.sh, not ENV: OpenShell starts processes with
# a clean environment and ignores image ENV.
COPY --chmod=755 docker/pi-agent.sh /usr/local/bin/pi-agent

# OpenShell sandbox policy (filesystem access, Landlock). Used when a sandbox is created
# without --policy; see openshell/policy.yaml.
COPY openshell/policy.yaml /etc/openshell/policy.yaml

# /sandbox is the workspace on every OpenShell runtime (Podman/K8s/MicroVM always use it).
# uid 1000 (node) is OpenShell's default sandbox identity.
RUN mkdir -p /sandbox && chown node:node /sandbox
USER node
WORKDIR /sandbox

# Usage (OpenShell): see openshell/README.md
# Usage (plain docker):
#   docker run --rm -e CPA_API_KEY -e CPA_CF_ACCESS_CLIENT_ID -e CPA_CF_ACCESS_CLIENT_SECRET \
#     -v "$PWD":/sandbox pi-agent run --task task.json
ENTRYPOINT ["/usr/local/bin/pi-agent"]
