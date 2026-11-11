import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";

/** pi's stdio server config (not exported by name). */
export type McpStdioServerConfig = Extract<McpServerConfig, { command: string }>;

/**
 * MCP servers a scenario can ask for (`Scenario.mcpServers`). The scenario profile extension
 * registers them (`pi.registerMcpServer`) at session start, in sandbox runs and in personal pi;
 * the wrapper loads pi's built-in MCP support for such scenarios and records the same decision
 * in report.json (`mcpServers`). Both decide with `decideMcpServers`, from the same workdir and
 * environment.
 */
export type McpPresetName = "gopls";

export type McpServerStatus =
  /** Registered with pi; it connects in the background. */
  | "registered"
  /** Not needed here (e.g. no Go module in the workdir). */
  | "skipped"
  /** Needed but its program is not installed; the run continues without it. */
  | "unavailable";

/** One preset's decision for a workdir. Also the report.json `mcpServers` item. */
export interface McpServerDecision {
  name: McpPresetName;
  status: McpServerStatus;
  /** Why it was skipped or unavailable. */
  reason?: string;
  /** Absolute path of the server program (registered only). */
  command?: string;
  /** The project file that made it apply, e.g. the go.mod (registered and unavailable). */
  root?: string;
}

export interface McpEnv {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** Nearest `names` file in `dir` or an ancestor (closest directory first, then name order). */
export function findUp(dir: string, names: readonly string[]): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    for (const n of names) {
      const p = join(d, n);
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        // not here
      }
    }
    if (dirname(d) === d) return undefined;
  }
}

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First executable `name` on PATH, then in `extraDirs`. */
export function findExecutable(name: string, env: NodeJS.ProcessEnv, extraDirs: readonly string[] = []): string | undefined {
  const dirs = [...(env.PATH ?? "").split(delimiter), ...extraDirs].filter((d) => d !== "");
  for (const d of dirs) {
    const p = join(d, name);
    if (executable(p)) return p;
  }
  return undefined;
}

/** Where `go install` puts binaries (GOBIN, each GOPATH entry's bin, ~/go/bin), for a PATH without them. */
function goBinDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  const gopath = env.GOPATH ? env.GOPATH.split(delimiter) : [];
  return [...(env.GOBIN ? [env.GOBIN] : []), ...gopath.map((p) => join(p, "bin")), join(home, "go", "bin")];
}

export const GO_PROJECT_FILES = ["go.work", "go.mod"] as const;

export const GOPLS_DESCRIPTION =
  "gopls, the Go language server: workspace layout, symbol search, file context, package API, references, diagnostics, rename diffs";

/**
 * gopls MCP server (`gopls mcp`, stdio). Codemode only: scripts call `mcp__gopls__go_*`.
 * `go_vulncheck` is hidden: it needs the network and is slow; run govulncheck at release time.
 * The first call waits for gopls to load the workspace, so the timeout is longer than pi's 60s.
 */
export function goplsConfig(command: string, cwd: string): McpStdioServerConfig {
  return {
    command,
    args: ["mcp"],
    cwd,
    exposure: "codemode",
    toolExposure: { go_vulncheck: "hidden" },
    description: GOPLS_DESCRIPTION,
    timeout: 180,
  };
}

function decideGopls(cwd: string, { env = process.env, home = homedir() }: McpEnv): McpServerDecision {
  const root = findUp(cwd, GO_PROJECT_FILES);
  if (!root) return { name: "gopls", status: "skipped", reason: "no go.mod or go.work in the workdir or its parents" };
  const command = findExecutable("gopls", env, goBinDirs(env, home));
  if (!command) {
    return {
      name: "gopls",
      status: "unavailable",
      root,
      reason: "gopls is not installed (go install golang.org/x/tools/gopls@latest); continuing without the gopls MCP server",
    };
  }
  return { name: "gopls", status: "registered", command, root };
}

/** Decisions for the scenario's presets, in order. */
export function decideMcpServers(names: readonly McpPresetName[], cwd: string, opts: McpEnv = {}): McpServerDecision[] {
  return names.map((n) => {
    switch (n) {
      case "gopls":
        return decideGopls(cwd, opts);
    }
  });
}

/** pi config for a registered decision. */
export function mcpServerConfig(d: McpServerDecision, cwd: string): McpStdioServerConfig {
  switch (d.name) {
    case "gopls":
      return goplsConfig(d.command!, cwd);
  }
}
