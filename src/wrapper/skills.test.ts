import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scenarioNames } from "../shared/scenarios/index.ts";
import { resolveSkills } from "./skills.ts";

/** Creates `files` (paths relative to a new temp dir) and returns the dir. */
async function tree(files: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-skills-"));
  for (const f of files) {
    await mkdir(dirname(join(root, f)), { recursive: true });
    await writeFile(join(root, f), "x");
  }
  return root;
}

test("resolveSkills: shared skills first, then the scenario's, each sorted", async () => {
  const dir = await tree([
    "README.md",
    "zeta/SKILL.md",
    "alpha/SKILL.md",
    "alpha/references/a.md",
    "review/b-skill/SKILL.md",
    "review/a-skill/SKILL.md",
    "review/README.md",
    "other/c-skill/SKILL.md",
    ".hidden/whatever.md",
  ]);
  assert.deepEqual(await resolveSkills(dir, "review", ["review", "other"]), [
    join(dir, "alpha"),
    join(dir, "zeta"),
    join(dir, "review/a-skill"),
    join(dir, "review/b-skill"),
  ]);
  // Another scenario gets the shared skills and its own only.
  assert.deepEqual(await resolveSkills(dir, "other", ["review", "other"]), [
    join(dir, "alpha"),
    join(dir, "zeta"),
    join(dir, "other/c-skill"),
  ]);
});

test("resolveSkills: a scenario without a folder gets the shared skills", async () => {
  const dir = await tree(["alpha/SKILL.md"]);
  assert.deepEqual(await resolveSkills(dir, "demo", ["demo"]), [join(dir, "alpha")]);
});

test("resolveSkills: a missing skills folder means no skills", async () => {
  assert.deepEqual(await resolveSkills(join(tmpdir(), "pi-agent-no-such-dir"), "demo", ["demo"]), []);
});

test("resolveSkills follows symlinked skill directories", async () => {
  const dir = await tree(["alpha/SKILL.md"]);
  const target = await tree(["SKILL.md"]);
  await symlink(target, join(dir, "linked"));
  assert.deepEqual(await resolveSkills(dir, "demo", ["demo"]), [join(dir, "alpha"), join(dir, "linked")]);
});

test("resolveSkills rejects an unknown top-level folder", async () => {
  const dir = await tree(["typo/x-skill/SKILL.md"]);
  await assert.rejects(resolveSkills(dir, "demo", ["demo"], ["grp"]), /typo: neither a shared skill .*grp.* \(known scenarios: demo\)/);
});

test("resolveSkills: group skills are shared, sorted in the group's place", async () => {
  const dir = await tree([
    "zeta/SKILL.md",
    "alpha/SKILL.md",
    "grp/README.md",
    "grp/grp-b/SKILL.md",
    "grp/grp-a/SKILL.md",
    "demo/own/SKILL.md",
  ]);
  assert.deepEqual(await resolveSkills(dir, "demo", ["demo"], ["grp"]), [
    join(dir, "alpha"),
    join(dir, "grp/grp-a"),
    join(dir, "grp/grp-b"),
    join(dir, "zeta"),
    join(dir, "demo/own"),
  ]);
});

test("resolveSkills: an empty or missing group folder is fine", async () => {
  const dir = await tree(["alpha/SKILL.md", "grp/README.md"]);
  assert.deepEqual(await resolveSkills(dir, "demo", ["demo"], ["grp", "missing"]), [join(dir, "alpha")]);
});

test("resolveSkills rejects a group subfolder without SKILL.md", async () => {
  const dir = await tree(["grp/notes/readme.md"]);
  await assert.rejects(resolveSkills(dir, "demo", ["demo"], ["grp"]), /grp\/notes: grouped skill without SKILL\.md/);
});

test("resolveSkills rejects a group folder that is also a skill", async () => {
  const dir = await tree(["grp/SKILL.md"]);
  await assert.rejects(resolveSkills(dir, "demo", ["demo"], ["grp"]), /grp: has SKILL\.md but is also a skill group/);
});

test("resolveSkills rejects a group named like a scenario", async () => {
  const dir = await tree(["alpha/SKILL.md"]);
  await assert.rejects(resolveSkills(dir, "demo", ["demo"], ["demo"]), /"demo" is both a skill group and a scenario name/);
});

test("resolveSkills rejects a grouped skill named like a shared one", async () => {
  const dir = await tree(["alpha/SKILL.md", "grp/alpha/SKILL.md"]);
  await assert.rejects(resolveSkills(dir, "demo", ["demo"], ["grp"]), /skill "alpha" is defined twice/);
});

test("resolveSkills rejects a folder that is both a skill and a scenario", async () => {
  const dir = await tree(["demo/SKILL.md"]);
  await assert.rejects(resolveSkills(dir, "demo", ["demo"]), /demo: has SKILL\.md but is also a scenario name/);
});

test("resolveSkills rejects a scenario subfolder without SKILL.md", async () => {
  const dir = await tree(["demo/notes/readme.md"]);
  await assert.rejects(resolveSkills(dir, "demo", ["demo"]), /demo\/notes: scenario skill without SKILL\.md/);
});

test("resolveSkills rejects a scenario skill named like a shared one", async () => {
  const dir = await tree(["alpha/SKILL.md", "demo/alpha/SKILL.md"]);
  await assert.rejects(resolveSkills(dir, "demo", ["demo"]), /skill "alpha" is defined twice/);
});

test("the repo's skills folder is valid for every scenario", async () => {
  const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills");
  for (const name of scenarioNames()) await resolveSkills(skillsDir, name, scenarioNames());
});
