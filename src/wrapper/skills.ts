import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

/** Marks a skill directory (Agent Skills spec). */
export const SKILL_FILE = "SKILL.md";

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
 * - `<scenario>/<skill>/SKILL.md`: a skill loaded only for that scenario.
 *
 * Shared skills come first, then the scenario's, each sorted by directory name, so the
 * skills part of the system prompt (and its cached prefix) stays byte-stable. Throws on a
 * top-level directory that is neither a skill nor a known scenario, on a directory that is
 * both, on a scenario subdirectory without SKILL.md, and on duplicate skill directory names
 * (pi would silently keep the first). Files (READMEs) and dot entries are ignored. A missing
 * `skillsDir` means no skills.
 */
export async function resolveSkills(skillsDir: string, scenario: string, knownScenarios: readonly string[]): Promise<string[]> {
  if (!(await isDir(skillsDir))) return [];
  const known = new Set(knownScenarios);
  const shared: string[] = [];
  let scenarioDir: string | undefined;

  for (const name of await subdirs(skillsDir)) {
    const dir = join(skillsDir, name);
    const isSkill = await isFile(join(dir, SKILL_FILE));
    if (isSkill && known.has(name)) {
      throw new Error(`${dir}: has ${SKILL_FILE} but is also a scenario name; rename the skill`);
    }
    if (isSkill) shared.push(dir);
    else if (!known.has(name)) {
      throw new Error(
        `${dir}: neither a shared skill (no ${SKILL_FILE}) nor a scenario folder (known scenarios: ${[...known].join(", ")})`,
      );
    } else if (name === scenario) scenarioDir = dir;
  }

  const own: string[] = [];
  if (scenarioDir) {
    for (const name of await subdirs(scenarioDir)) {
      const dir = join(scenarioDir, name);
      if (!(await isFile(join(dir, SKILL_FILE)))) throw new Error(`${dir}: scenario skill without ${SKILL_FILE}`);
      own.push(dir);
    }
  }

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
