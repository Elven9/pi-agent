import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

/** Marks a skill directory (Agent Skills spec). */
export const SKILL_FILE = "SKILL.md";

/**
 * Group folders: `skills/<group>/<skill>/SKILL.md` are shared skills (loaded for every scenario),
 * kept together only for organization. Listed explicitly so a misspelled scenario folder still
 * fails instead of silently becoming shared.
 */
export const SKILL_GROUPS: readonly string[] = ["synology"];

async function isDir(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

/** Visible subdirectories (symlinks followed), sorted by name so the skill order is stable. */
async function subdirs(dir: string): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => !n.startsWith(".")).sort();
  const dirs: string[] = [];
  for (const name of names) if (await isDir(join(dir, name))) dirs.push(name);
  return dirs;
}

/**
 * Skill directories for one scenario run, as absolute paths (one `--skill` each).
 *
 * Layout of `skillsDir`:
 * - `<skill>/SKILL.md`: a shared skill, loaded for every scenario.
 * - `<group>/<skill>/SKILL.md`: also a shared skill; `<group>` is in `groups` (SKILL_GROUPS).
 * - `<scenario>/<skill>/SKILL.md`: a skill loaded only for that scenario.
 *
 * Shared skills come first (top-level folders sorted by name, a group's skills sorted in its
 * place), then the scenario's, sorted by directory name, so the skills part of the system
 * prompt (and its cached prefix) stays byte-stable. Throws on a top-level directory that is
 * neither a skill, a group nor a known scenario, on a directory that is more than one of those,
 * on a group or scenario subdirectory without SKILL.md, and on duplicate skill directory names
 * (pi would silently keep the first). Files (READMEs) and dot entries are ignored. A missing
 * `skillsDir` means no skills.
 */
export async function resolveSkills(
  skillsDir: string,
  scenario: string,
  knownScenarios: readonly string[],
  groups: readonly string[] = SKILL_GROUPS,
): Promise<string[]> {
  if (!(await isDir(skillsDir))) return [];
  const known = new Set(knownScenarios);
  const groupSet = new Set(groups);
  for (const g of groupSet) if (known.has(g)) throw new Error(`"${g}" is both a skill group and a scenario name`);
  const shared: string[] = [];
  let scenarioDir: string | undefined;

  for (const name of await subdirs(skillsDir)) {
    const dir = join(skillsDir, name);
    const isSkill = await isFile(join(dir, SKILL_FILE));
    if (isSkill && known.has(name)) {
      throw new Error(`${dir}: has ${SKILL_FILE} but is also a scenario name; rename the skill`);
    }
    if (isSkill && groupSet.has(name)) {
      throw new Error(`${dir}: has ${SKILL_FILE} but is also a skill group; rename the skill`);
    }
    if (isSkill) shared.push(dir);
    else if (groupSet.has(name)) shared.push(...(await skillSubdirs(dir, "grouped")));
    else if (!known.has(name)) {
      throw new Error(
        `${dir}: neither a shared skill (no ${SKILL_FILE}), a skill group (${[...groupSet].join(", ")}) nor a scenario folder (known scenarios: ${[...known].join(", ")})`,
      );
    } else if (name === scenario) scenarioDir = dir;
  }

  const own = scenarioDir ? await skillSubdirs(scenarioDir, "scenario") : [];

  const all = [...shared, ...own];
  const seen = new Map<string, string>();
  for (const dir of all) {
    const name = basename(dir);
    const other = seen.get(name);
    if (other) throw new Error(`skill "${name}" is defined twice: ${other} and ${dir}`);
    seen.set(name, dir);
  }
  return all;
}

/** Subdirectories of a group or scenario folder; each must be a skill. */
async function skillSubdirs(parent: string, kind: "grouped" | "scenario"): Promise<string[]> {
  const dirs: string[] = [];
  for (const name of await subdirs(parent)) {
    const dir = join(parent, name);
    if (!(await isFile(join(dir, SKILL_FILE)))) throw new Error(`${dir}: ${kind} skill without ${SKILL_FILE}`);
    dirs.push(dir);
  }
  return dirs;
}
