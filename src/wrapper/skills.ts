import { readdirSync, readFileSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { externalSkillRoots, findExternalSkills } from "../shared/external-skills.ts";

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

/**
 * `packageSkills` (from resolveSkills) followed by the scenario's included external skills
 * that are installed (`include` order). An external skill named like one of this package's
 * skills is left out: pi would keep the first anyway. Other external skills need no handling
 * here: the run (`-ns`) loads no external skill that is not included.
 */
export function withExternalSkills(
  packageSkills: readonly string[],
  include: readonly string[] = [],
  roots: readonly string[] = externalSkillRoots(),
): string[] {
  const own = new Set(packageSkills.map((dir) => basename(dir)));
  const external = findExternalSkills(include.filter((n) => !own.has(n)), roots, (root) => scanSkillDirs(root));
  return [...packageSkills, ...external.map((s) => s.baseDir)];
}

/** An installed skill folder found by scanSkillDirs. */
export interface InstalledSkill {
  name: string;
  /** Folder with SKILL.md. */
  baseDir: string;
  filePath: string;
}

function stats(path: string) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/** Skill name like pi: frontmatter `name`, else the folder name. Undefined when pi would not load it. */
function skillName(filePath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  let meta: unknown = {};
  if (match) {
    try {
      meta = parseYaml(match[1]) ?? {};
    } catch {
      return undefined;
    }
  }
  const fm = (typeof meta === "object" && meta !== null ? meta : {}) as Record<string, unknown>;
  if (typeof fm.description !== "string" || fm.description.trim() === "") return undefined;
  return typeof fm.name === "string" && fm.name !== "" ? fm.name : basename(filePath.slice(0, -SKILL_FILE.length - 1));
}

/**
 * Skill folders under `dir`, like pi's scan: a folder with SKILL.md is a skill (no deeper),
 * otherwise its subfolders are searched; dot folders and node_modules are skipped, symlinks
 * followed. Sorted by folder name. Standalone \`.md\` skills and .gitignore rules are not supported.
 */
export function scanSkillDirs(dir: string, out: InstalledSkill[] = []): InstalledSkill[] {
  const file = join(dir, SKILL_FILE);
  if (stats(file)?.isFile()) {
    const name = skillName(file);
    if (name !== undefined) out.push({ name, baseDir: dir, filePath: file });
    return out;
  }
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const n of names) {
    if (n.startsWith(".") || n === "node_modules") continue;
    if (stats(join(dir, n))?.isDirectory()) scanSkillDirs(join(dir, n), out);
  }
  return out;
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
