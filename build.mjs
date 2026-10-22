// Bundles the wrapper and the extension into dist/ (one file each, no node_modules needed).
//
// - dist/pi-agent.js: the wrapper. Everything it imports is bundled in; it only needs node and
//   a `pi` executable at runtime.
// - dist/extension.js (runner), dist/scenario-profile.js (scenario prompt/tools/skills),
//   dist/project.js (project context), dist/metrics.js (session metrics) and dist/tool-ref.js
//   (tool-call handles, loaded last): loaded by pi (-e). pi
//   provides typebox and its own packages to extensions, so those stay external (bundling a
//   copy would bypass pi's module mapping). yaml is bundled.
//
// Markdown imports (`import prompt from "./prompts/x.md"`, scenario system prompts) are inlined
// as strings, so dist/ needs no .md files at runtime.
//
// Source maps (linked, with embedded sources) are on by default for local debugging. Set
// PI_AGENT_SOURCEMAP=0 to omit them (the Docker image does, so no sources ship in it).
import { build } from "esbuild";
import { chmod, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

// yaml's Node entry is CommonJS and calls require("process"); ESM bundles have no `require`.
const requireShim = 'import { createRequire as __piAgentCreateRequire } from "node:module";\nconst require = __piAgentCreateRequire(import.meta.url);';

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  sourcemap: process.env.PI_AGENT_SOURCEMAP === "0" ? false : "linked",
  legalComments: "none",
  loader: { ".md": "text" },
  logLevel: "info",
};

await build({
  ...common,
  entryPoints: { "pi-agent": "src/wrapper/main.ts" },
  outdir: "dist",
  banner: { js: `#!/usr/bin/env node\n${requireShim}` },
});
await chmod("dist/pi-agent.js", 0o755);

await build({
  ...common,
  entryPoints: {
    extension: "src/extension/index.ts",
    "scenario-profile": "src/scenario-profile/index.ts",
    project: "src/project/index.ts",
    metrics: "src/metrics/index.ts",
    "tool-ref": "src/tool-ref/index.ts",
  },
  outdir: "dist",
  external: ["typebox", "typebox/*", "@earendil-works/*"],
  banner: { js: requireShim },
});
