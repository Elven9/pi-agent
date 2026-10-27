/**
 * Global rules: always-on rules for every session that loads the scenario-profile extension.
 *
 * - Without `--scenario`: added to pi's own `<rules>` (after the tool guidelines, before pi's
 *   fixed "Be concise ..." rules).
 * - With `--scenario`: added to the scenario's `<rules>`, after its own `rules` and the tool
 *   guidelines.
 *
 * Keep them short and stable: they are part of the cached prompt prefix, so changing one
 * invalidates the cache for every session. Rules are trimmed; empty or duplicate ones are an error
 * (see the test).
 */
export const GLOBAL_RULES: readonly string[] = [
  "When searching for text or files, prefer using rg or rg --files respectively because rg is much faster than alternatives like grep. (If the rg command is not found, then use alternatives.)",
];
