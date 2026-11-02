import globalRules from "./rules/global.md";

/** Name of the system prompt section with the global rules (`<global_rules>`). */
export const GLOBAL_RULES_SECTION = "global_rules";

/**
 * Global rules: always-on rules for every session that loads the scenario-profile extension,
 * written in `rules/global.md` and added as is (trimmed) as the `<global_rules>` section, with or
 * without `--scenario`. Like a scenario's system prompt, the Markdown is inlined at build time.
 *
 * The section follows `<rules>` (pi's or the scenario's) and comes before the project's sections,
 * so it is in cache block A. Keep the rules short and stable: changing one invalidates the cache
 * for every session.
 */
export const GLOBAL_RULES: string = globalRules.trim();
