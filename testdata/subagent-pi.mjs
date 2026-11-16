// Command line of a real pi child for subagent process tests: the pinned pi CLI in RPC mode, no
// extensions but the scripted faux model (and, with `subagent: true`, the subagent extension in
// child mode, loaded from source with the .md loader).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const PI_CLI = here("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const MD_LOADER = here("../scripts/md-loader.mjs");
const FAUX = here("./subagent-faux-ext.ts");
const SUBAGENT = here("../src/subagent/index.ts");

/** `steps`: the faux model's answers (FAUX_STEPS). */
export function childPiArgs(steps, { subagent = false } = {}) {
  const args = ["--import", MD_LOADER, PI_CLI, "--mode", "rpc", "--no-extensions", "-e", FAUX, ...(subagent ? ["-e", SUBAGENT] : []), "--provider", "faux", "--model", "m", "--no-session"];
  const agentDir = mkdtempSync(join(tmpdir(), "subagent-pi-"));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_AGENT_SUBAGENT: "1", FAUX_STEPS: JSON.stringify(steps) };
  return { args, options: { cwd: process.cwd(), env } };
}
