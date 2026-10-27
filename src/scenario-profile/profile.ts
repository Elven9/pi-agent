import { isAbsolute, relative, sep } from "node:path";

/** pi's path prefix for built-in tools (`sourceInfo.path`, e.g. `builtin:read`). */
const BUILTIN_PREFIX = "builtin:";

export interface ToolSource {
  name: string;
  sourceInfo: { path: string };
}

/**
 * Built-in tools whose guidelines a scenario keeps. codemode's say when to write a script; with
 * `codemode.mode: "only"` it is the model's main tool, and a scenario prompt does not cover that.
 */
const BUILTIN_RULES_KEPT = new Set(["codemode"]);

export function isBuiltinTool(tool: ToolSource): boolean {
  return tool.sourceInfo.path.startsWith(BUILTIN_PREFIX);
}

/**
 * Active tools for a scenario: built-in tools are exactly the scenario's (in its order), tools
 * from extensions (e.g. the runner's `submit_result`, MCP tools) stay as they are.
 */
export function scenarioActiveTools(scenarioTools: readonly string[], active: readonly string[], all: readonly ToolSource[]): string[] {
  const builtin = new Set(all.filter(isBuiltinTool).map((t) => t.name));
  const fromExtensions = active.filter((name) => !builtin.has(name) && !scenarioTools.includes(name));
  return [...scenarioTools, ...fromExtensions];
}

/**
 * The `<rules>` section for a scenario prompt. pi builds `<rules>` only for its default prompt,
 * so with `customPrompt` extension tools' `promptGuidelines` would be lost. This restores just
 * those, after the scenario's own `rules`: guidelines of active tools that are not built-in (in active order), then the run's
 * global `promptGuidelines`; trimmed and de-duplicated like pi does. Built-in tools' guidelines
 * and pi's fixed rules ("Be concise", ...) stay out: the scenario prompt decides those; except
 * codemode's (BUILTIN_RULES_KEPT).
 *
 * Hidden tools (`hiddenTools`: with `codemode.mode: "only"`, the tools only scripts call) are
 * left out, like pi's own `<rules>` does: the codemode description already carries their
 * guidelines. Returns undefined when there is nothing to add.
 */
export function scenarioRules(
  scenarioOwn: readonly string[],
  active: readonly string[],
  all: readonly ToolSource[],
  toolGuidelines: Readonly<Record<string, readonly string[]>>,
  promptGuidelines: readonly string[],
  hiddenTools: readonly string[] = [],
): string | undefined {
  const skip = new Set([...all.filter((t) => isBuiltinTool(t) && !BUILTIN_RULES_KEPT.has(t.name)).map((t) => t.name), ...hiddenTools]);
  const rules = new Set<string>();
  const add = (rule: string) => {
    const r = rule.trim();
    if (r) rules.add(r);
  };
  scenarioOwn.forEach(add);
  for (const name of active) if (!skip.has(name)) (toolGuidelines[name] ?? []).forEach(add);
  promptGuidelines.forEach(add);
  return rules.size > 0 ? [...rules].map((r) => `- ${r}`).join("\n") : undefined;
}

/** Whether a skill folder is inside this package's skills dir (strictly; the dir itself is not). */
export function isPackageSkill(baseDir: string, skillsDir: string): boolean {
  const rel = relative(skillsDir, baseDir);
  return !(rel === "" || rel.startsWith("..") || isAbsolute(rel));
}

/**
 * Whether a skill stays in the prompt for `scenario`. Only this package's scenario skills
 * (`<skillsDir>/<other scenario>/<skill>/`) are dropped; shared and grouped skills, the
 * scenario's own and skills from anywhere else (personal skills, other packages) stay.
 * Same selection as the wrapper's resolveSkills, without its layout checks.
 */
export function keepSkill(baseDir: string, skillsDir: string, scenario: string, knownScenarios: readonly string[]): boolean {
  if (!isPackageSkill(baseDir, skillsDir)) return true;
  const rel = relative(skillsDir, baseDir);
  const top = rel.split(sep)[0];
  return top === scenario || !knownScenarios.includes(top);
}
