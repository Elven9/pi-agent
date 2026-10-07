// Lets Node import .md files as text when running the .ts sources directly (tests, `npm run dev`),
// the same way esbuild's text loader does in the bundles (build.mjs). Use with `node --import`.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    if (new URL(url).pathname.endsWith(".md")) {
      const text = readFileSync(new URL(url), "utf8");
      return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(text)};` };
    }
    return nextLoad(url, context);
  },
});
