import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A scenario's choice of external skills: skills installed on the machine outside this package
 * (see externalSkillRoots), named by skill name (frontmatter `name`, else the folder name).
 *
 * Under a scenario, external skills are excluded by default, in both the runner and personal pi
 * (`--scenario`). `include` names the ones the scenario gets, when installed: the runner passes
 * them with `--skill`, personal pi keeps them in the prompt (and adds them if pi's own config
 * left them out). Not installed: ignored. This package's skills (`skills/`) are not affected.
 */
export interface ExternalSkillsConfig {
  include?: string[];
}

/** Throws on an empty name or a name listed twice (called by defineScenario). */
export function validateExternalSkills(scenario: string, config: ExternalSkillsConfig | undefined): void {
  const names = config?.include ?? [];
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined) throw new Error(`scenario "${scenario}": external skill "${dup}" is listed twice in include`);
  if (names.some((n) => n.trim() === "")) throw new Error(`scenario "${scenario}": empty external skill name in include`);
}

/**
 * User-level skill folders, in pi's order: `<agent dir>/skills` (PI_CODING_AGENT_DIR, else
 * ~/.pi/agent), then the Agent Skills folder ~/.agents/skills. Project folders (`.pi/skills`,
 * `.agents/skills`) are not searched: the runner's workdir is not trusted.
 */
export function externalSkillRoots(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const raw = env.PI_CODING_AGENT_DIR;
  const agentDir = raw ? (raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw) : join(home, ".pi", "agent");
  return [join(agentDir, "skills"), join(home, ".agents", "skills")];
}

/**
 * The installed skills with the given names, in `names` order; names not installed are left
 * out. `scanRoot` lists the skills under one root (the runner scans folders itself, the
 * extension uses pi's loader); missing roots give none. On duplicate names the first root (then
 * scan order) wins, as in pi.
 */
export function findExternalSkills<S extends { name: string }>(
  names: readonly string[],
  roots: readonly string[],
  scanRoot: (root: string) => readonly S[],
): S[] {
  if (names.length === 0) return [];
  const wanted = new Set(names);
  const found = new Map<string, S>();
  for (const root of roots) {
    for (const skill of scanRoot(root)) if (wanted.has(skill.name) && !found.has(skill.name)) found.set(skill.name, skill);
  }
  return names.flatMap((n) => found.get(n) ?? []);
}
