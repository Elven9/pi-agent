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
