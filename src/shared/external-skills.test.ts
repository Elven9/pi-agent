import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanSkillDirs } from "../wrapper/skills.ts";
import { externalSkillRoots, findExternalSkills as find, validateExternalSkills } from "./external-skills.ts";

const findExternalSkills = (names: string[], roots: string[]) => find(names, roots, (root) => scanSkillDirs(root));
import { getScenario, scenarioNames } from "./scenarios/index.ts";

const skillMd = (name: string | undefined, description = "Does things") =>
  `---\n${name ? `name: ${name}\n` : ""}description: ${description}\n---\n# body\n`;

async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-ext-skills-"));
  for (const [f, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, f)), { recursive: true });
    await writeFile(join(root, f), content);
  }
  return root;
}

test("findExternalSkills + scanSkillDirs: by skill name, in the requested order, missing ones ignored", async () => {
  const root = await tree({
    "agent-browser/SKILL.md": skillMd("agent-browser"),
    "nested/group/renamed-dir/SKILL.md": skillMd("deep-skill"),
    "no-name/SKILL.md": skillMd(undefined),
    "no-desc/SKILL.md": "---\nname: no-desc\n---\n",
    "node_modules/hidden/SKILL.md": skillMd("hidden"),
    ".dot/SKILL.md": skillMd("dot"),
  });
  const found = findExternalSkills(["no-name", "missing", "deep-skill", "agent-browser", "no-desc", "hidden", "dot"], [root]);
  assert.deepEqual(
    found.map((s) => [s.name, s.baseDir]),
    [
      ["no-name", join(root, "no-name")],
      ["deep-skill", join(root, "nested/group/renamed-dir")],
      ["agent-browser", join(root, "agent-browser")],
    ],
  );
  assert.deepEqual(findExternalSkills([], [root]), []);
  assert.deepEqual(findExternalSkills(["x"], [join(root, "does-not-exist")]), []);
});

test("findExternalSkills: the first root wins on duplicate names; symlinks are followed", async () => {
  const a = await tree({ "dup/SKILL.md": skillMd("dup") });
  const b = await tree({ "dup/SKILL.md": skillMd("dup") });
  const target = await tree({ "SKILL.md": skillMd("linked") });
  await symlink(target, join(b, "link"));
  assert.deepEqual(
    findExternalSkills(["dup", "linked"], [a, b]).map((s) => s.baseDir),
    [join(a, "dup"), join(b, "link")],
  );
});

test("externalSkillRoots: agent dir first, then ~/.agents/skills", () => {
  assert.deepEqual(externalSkillRoots({}, "/h"), ["/h/.pi/agent/skills", "/h/.agents/skills"]);
  assert.deepEqual(externalSkillRoots({ PI_CODING_AGENT_DIR: "~/agent" }, "/h"), ["/h/agent/skills", "/h/.agents/skills"]);
  assert.deepEqual(externalSkillRoots({ PI_CODING_AGENT_DIR: "/x" }, "/h"), ["/x/skills", "/h/.agents/skills"]);
});

test("validateExternalSkills rejects duplicates and empty names", () => {
  validateExternalSkills("s", undefined);
  validateExternalSkills("s", { include: ["a", "b"] });
  assert.throws(() => validateExternalSkills("s", { include: ["a", "a"] }), /"a" is listed twice in include/);
  assert.throws(() => validateExternalSkills("s", { include: [" "] }), /empty external skill name in include/);
});

test("every registered scenario has a valid externalSkills config", () => {
  for (const name of scenarioNames()) validateExternalSkills(name, getScenario(name).externalSkills);
});
