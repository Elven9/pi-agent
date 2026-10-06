// Bundles the wrapper and the extension into dist/ (one file each, no node_modules needed).
//
// - dist/pi-agent.js: the wrapper. Everything it imports is bundled in; it only needs node and
//   a `pi` executable at runtime.
// - dist/extension.js: loaded by pi (-e). pi provides typebox and its own packages to
//   extensions, so those stay external (bundling a copy would bypass pi's module mapping).
import { build } from "esbuild";
import { chmod, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  sourcemap: "linked",
  legalComments: "none",
  logLevel: "info",
};

await build({
  ...common,
  entryPoints: { "pi-agent": "src/wrapper/main.ts" },
  outdir: "dist",
  banner: { js: "#!/usr/bin/env node" },
});
await chmod("dist/pi-agent.js", 0o755);

await build({
  ...common,
  entryPoints: { extension: "src/extension/index.ts" },
  outdir: "dist",
  external: ["typebox", "typebox/*", "@earendil-works/*"],
});
