import { isAbsolute, relative, sep } from "node:path";

/** pi's path prefix for built-in tools (`sourceInfo.path`, e.g. `builtin:read`). */
const BUILTIN_PREFIX = "builtin:";

export interface ToolSource {
  name: string;
  sourceInfo: { path: string };
}

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
 * those: guidelines of active tools that are not built-in (in active order), then the run's
 * global `promptGuidelines`; trimmed and de-duplicated like pi does. Built-in tools' guidelines
 * and pi's fixed rules ("Be concise", ...) stay out: the scenario prompt decides those.
 * Returns undefined when there is nothing to add.
 */
export function scenarioRules(
  active: readonly string[],
  all: readonly ToolSource[],
  toolGuidelines: Readonly<Record<string, readonly string[]>>,
  promptGuidelines: readonly string[],
): string | undefined {
  const builtin = new Set(all.filter(isBuiltinTool).map((t) => t.name));
  const rules = new Set<string>();
  const add = (rule: string) => {
    const r = rule.trim();
    if (r) rules.add(r);
  };
  for (const name of active) if (!builtin.has(name)) (toolGuidelines[name] ?? []).forEach(add);
  promptGuidelines.forEach(add);
  return rules.size > 0 ? [...rules].map((r) => `- ${r}`).join("\n") : undefined;
}

/**
 * Whether a skill stays in the prompt for `scenario`. Only this package's scenario skills
 * (`<skillsDir>/<other scenario>/<skill>/`) are dropped; shared and grouped skills, the
 * scenario's own and skills from anywhere else (personal skills, other packages) stay.
 * Same selection as the wrapper's resolveSkills, without its layout checks.
 */
export function keepSkill(baseDir: string, skillsDir: string, scenario: string, knownScenarios: readonly string[]): boolean {
  const rel = relative(skillsDir, baseDir);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return true;
  const top = rel.split(sep)[0];
  return top === scenario || !knownScenarios.includes(top);
}
