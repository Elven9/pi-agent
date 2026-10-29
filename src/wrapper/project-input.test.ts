import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject } from "./project-input.ts";
import type { CliRunner } from "../shared/project-source.ts";

async function tmp(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-input-"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

const manifest = (name: string) => ({ "project.yaml": `version: 1\nname: ${name}\n` });
/** An agent dir whose settings.json has this project entry. */
const agentDir = async (project: object) => tmp({ "settings.json": JSON.stringify({ project }) });
const noCli: CliRunner = async () => assert.fail("gh/glab must not run");
const name = (r: Awaited<ReturnType<typeof resolveProject>>) => r.project?.manifest.name;

test("order: --project, then PI_AGENT_PROJECT, then settings.json", async () => {
  const flag = await tmp(manifest("flag"));
  const envDir = await tmp(manifest("env"));
  const local = await tmp(manifest("settings"));
  const workdir = await tmp({});
  const agent = await agentDir({ type: "local", dir: local });
  const env = { PI_CODING_AGENT_DIR: agent, PI_AGENT_PROJECT: envDir };

  assert.equal(name(await resolveProject({ flag, workdir, env, run: noCli })), "flag");
  assert.equal(name(await resolveProject({ workdir, env, run: noCli })), "env");
  assert.equal(name(await resolveProject({ workdir, env: { PI_CODING_AGENT_DIR: agent }, run: noCli })), "settings");
  // The env folder without project.yaml (the image's default /project) doesn't hide the entry.
  const fallthrough = await resolveProject({ workdir, env: { ...env, PI_AGENT_PROJECT: await tmp({}) }, run: noCli });
  assert.deepEqual([name(fallthrough), fallthrough.warnings], ["settings", []]);
});

test("settings.json local: relative dir against the workdir; missing project.yaml is an error", async () => {
  const workdir = await tmp({});
  const proj = join(workdir, "proj");
  await mkdir(proj);
  await writeFile(join(proj, "project.yaml"), "version: 1\nname: rel\n");
  const env = { PI_CODING_AGENT_DIR: await agentDir({ type: "local", dir: "proj" }) };
  const result = await resolveProject({ workdir, env, run: noCli });
  assert.equal(name(result), "rel");
  assert.equal(result.project!.dir, proj);

  const empty = { PI_CODING_AGENT_DIR: await agentDir({ type: "local", dir: "nope" }) };
  await assert.rejects(resolveProject({ workdir, env: empty, run: noCli }), /Cannot read .*nope\/project\.yaml: no such file/);
});

test("nothing found: warning only when PI_AGENT_PROJECT was set; invalid entry or manifest is an error", async () => {
  const workdir = await tmp({});
  const emptyAgent = await tmp({});
  assert.deepEqual(await resolveProject({ workdir, env: { PI_CODING_AGENT_DIR: emptyAgent } }), { project: undefined, warnings: [] });
  const envDir = await tmp({});
  const r = await resolveProject({ workdir, env: { PI_CODING_AGENT_DIR: emptyAgent, PI_AGENT_PROJECT: envDir } });
  assert.deepEqual(r.warnings, [`no project.yaml in ${envDir} (PI_AGENT_PROJECT); running without project context`]);

  const untyped = { PI_CODING_AGENT_DIR: await agentDir({ dir: "x" }) };
  await assert.rejects(resolveProject({ workdir, env: untyped }), /\/type must be one of github, gitlab, local/);
  const badEnv = await tmp({ "project.yaml": "version: 1\nname: x\nbogus: 1\n" });
  await assert.rejects(resolveProject({ workdir, env: { PI_CODING_AGENT_DIR: emptyAgent, PI_AGENT_PROJECT: badEnv } }), /bogus is not a known key/);
});
