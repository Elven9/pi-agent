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
 * those, after the scenario's own `rules` (its Markdown, as is): guidelines of active tools that
 * are not built-in (in active order), then the run's `promptGuidelines` (from other extensions;
 * the global rules are a separate section), as `- ` bullets, trimmed and de-duplicated like pi
 * does. Built-in tools' guidelines
 * and pi's fixed rules ("Be concise", ...) stay out: the scenario prompt decides those; except
 * codemode's (BUILTIN_RULES_KEPT).
 *
 * Hidden tools (`hiddenTools`: with `codemode.mode: "only"`, the tools only scripts call) are
 * left out, like pi's own `<rules>` does: the codemode description already carries their
 * guidelines. Returns undefined when there is nothing to add.
 */
export function scenarioRules(
  scenarioOwn: string | undefined,
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
  for (const name of active) if (!skip.has(name)) (toolGuidelines[name] ?? []).forEach(add);
  promptGuidelines.forEach(add);
  const parts = [scenarioOwn?.trim(), ...[...rules].map((r) => `- ${r}`)].filter((p) => p);
  return parts.length > 0 ? parts.join("\n") : undefined;
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

/** What decides a session's skills: the scenario (if any) and the project's `skills.include` (if any). */
export interface SkillRules {
  /** This package's skills dir (real path). */
  skillsDir: string;
  scenario?: {
    name: string;
    known: readonly string[];
    /** The scenario's `externalSkills.include`. */
    include: ReadonlySet<string>;
  };
  /** The project's `skills.include`; undefined when the project does not set it. */
  project?: ReadonlySet<string>;
}

/**
 * Whether a loaded skill (`baseDir`: its real folder) stays in the prompt:
 * - neither a scenario nor project skills: every skill pi loaded,
 * - a skill the project includes: always,
 * - with a scenario: this package's shared skills and the scenario's own (keepSkill), external
 *   skills only when the scenario includes them,
 * - project skills without a scenario: only the project's.
 */
export function skillActive(rules: SkillRules, name: string, baseDir: string): boolean {
  if (!rules.scenario && !rules.project) return true;
  if (rules.project?.has(name)) return true;
  const s = rules.scenario;
  if (!s) return false;
  return isPackageSkill(baseDir, rules.skillsDir) ? keepSkill(baseDir, rules.skillsDir, s.name, s.known) : s.include.has(name);
}
