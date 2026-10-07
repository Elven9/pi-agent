import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  describeBlock,
  loadProject,
  normalizeText,
  readAgentsMd,
  renderBlock,
  renderProjectSections,
} from "./project.ts";

/** Temp folder with the given files (path → content). */
async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-agent-project-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

const MANIFEST = `version: 1
name: billing-service
description: |
  Payment and invoicing backend (Node 22, Postgres).
rules:
  - Never commit to main; work on the current branch.
  - "Do not add dependencies\\nwithout saying why."
commands:
  npm test: Run all unit tests.
  npm ci: Install dependencies from the lockfile.
  "npm test -- --grep <pattern>": Run only the tests matching a pattern.
workflows:
  - path: workflows/release.md
    when: Cutting a release or bumping the version.
docs:
  - path: docs/architecture.md
    when: Before changing module boundaries.
`;

const projectFiles = {
  "project.yaml": MANIFEST,
  "workflows/release.md": "1. Bump\n",
  "docs/architecture.md": "# Arch\n",
};

test("renders block B in the documented order, keeping the manifest's order", async () => {
  const project = await loadProject(await folder(projectFiles));
  const sections = renderProjectSections({
    cwd: "/sandbox",
    project: { ...project!, dir: "/project" },
    agentsMd: { path: "/sandbox/AGENTS.md", content: "\n# Agents\r\nUse pnpm.   \n\n\n" },
  });
  assert.equal(
    renderBlock(sections),
    `<project>
name: billing-service
Payment and invoicing backend (Node 22, Postgres).
</project>

<project_rules>
- Never commit to main; work on the current branch.
- Do not add dependencies
  without saying why.
</project_rules>

<agents_md>
path: /sandbox/AGENTS.md
# Agents
Use pnpm.
</agents_md>

<project_commands>
Run from /sandbox:
- \`npm test\`: Run all unit tests.
- \`npm ci\`: Install dependencies from the lockfile.
- \`npm test -- --grep <pattern>\`: Run only the tests matching a pattern.
</project_commands>

<project_workflows>
Before doing one of these tasks, read its file and follow the steps in order:
- /project/workflows/release.md: Cutting a release or bumping the version.
</project_workflows>

<project_docs>
Read a doc when its condition applies:
- /project/docs/architecture.md: Before changing module boundaries.
</project_docs>`,
  );
});

test("rendering is byte-identical across loads; the hash tracks content", async () => {
  const dir = await folder(projectFiles);
  const render = async () => renderProjectSections({ cwd: "/w", project: await loadProject(dir) });
  const a = describeBlock(await render());
  assert.deepEqual(describeBlock(await render()), a);
  assert.deepEqual(a.sections, ["project", "project_rules", "project_commands", "project_workflows", "project_docs"]);
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  assert.equal(a.approxTokens, Math.ceil(a.chars / 4));
  const other = describeBlock(renderProjectSections({ cwd: "/other", project: await loadProject(dir) }));
  assert.notEqual(other.sha256, a.sha256);
});

test("leaves out empty sections; AGENTS.md alone works without a manifest", async () => {
  const minimal = await loadProject(await folder({ "project.yaml": "version: 1\nname: x\nrules: []\n" }));
  assert.deepEqual(renderProjectSections({ cwd: "/w", project: minimal }), { project: "name: x" });
  assert.deepEqual(renderProjectSections({ cwd: "/w", agentsMd: { path: "/w/AGENTS.md", content: "Hi" } }), {
    agents_md: "path: /w/AGENTS.md\nHi",
  });
  assert.equal(renderBlock({}), "");
});

test("commands containing backticks stay readable", async () => {
  const p = await loadProject(await folder({ "project.yaml": "version: 1\nname: x\ncommands:\n  'echo `date`': Print the date.\n" }));
  assert.equal(renderProjectSections({ cwd: "/w", project: p }).project_commands, "Run from /w:\n- `` echo `date` ``: Print the date.");
});

test("loadProject: missing file is an error unless optional", async () => {
  const dir = await folder({});
  await assert.rejects(loadProject(dir), /Cannot read .*project\.yaml/);
  assert.equal(await loadProject(dir, { optional: true }), undefined);
  assert.equal(await loadProject(join(dir, "nope"), { optional: true }), undefined);
});

test("loadProject reports every problem", async () => {
  const invalid = async (yaml: string, files: Record<string, string> = {}) => {
    const err = await loadProject(await folder({ "project.yaml": yaml, ...files })).then(
      () => assert.fail("expected an error"),
      (e: Error) => e.message,
    );
    return err;
  };
  assert.match(await invalid("version: [\n"), /Invalid .*project\.yaml: /);
  assert.match(await invalid("version: 2\nname: x\n"), /\/version/);
  assert.match(await invalid("version: 1\nname: x\ninstruction: [a]\n"), /\/instruction is not a known key$/);
  assert.match(await invalid("version: 1\nname: x\ncommands:\n  a: \"two\\nlines\"\n"), /\/commands\/a/);
  assert.match(await invalid("version: 1\nname: x\ncommands:\n  \"a\\nb\": x\n"), /must be a single non-empty line/);
  assert.match(await invalid("version: 1\nname: x\nname: y\n"), /Invalid .*project\.yaml/); // duplicate key

  const paths = await invalid(
    `version: 1
name: x
workflows:
  - { path: w.md, when: a }
  - { path: missing.md, when: b }
  - { path: /etc/passwd, when: c }
docs:
  - { path: ./w.md, when: d }
  - { path: ../outside.md, when: e }
  - { path: sub, when: f }
`,
    { "w.md": "", "sub/x.md": "" },
  );
  assert.match(paths, /\/workflows\/1\/path: missing\.md is not a file/);
  assert.match(paths, /\/workflows\/2\/path: \/etc\/passwd must be a relative path/);
  assert.match(paths, /\/docs\/0\/path: \.\/w\.md is already listed at \/workflows\/0\/path/);
  assert.match(paths, /\/docs\/1\/path: \.\.\/outside\.md must be a relative path/);
  assert.match(paths, /\/docs\/2\/path: sub is not a file/);
});

test("readAgentsMd reads only <cwd>/AGENTS.md and skips blank files", async () => {
  const dir = await folder({ "AGENTS.md": "Rules\n", "sub/AGENTS.md": "nested" });
  assert.deepEqual(await readAgentsMd(dir), { path: join(dir, "AGENTS.md"), content: "Rules\n" });
  assert.equal(await readAgentsMd(join(dir, "sub", "none")), undefined);
  assert.equal(await readAgentsMd(await folder({ "AGENTS.md": " \n\n" })), undefined);
});

test("normalizeText", () => {
  assert.equal(normalizeText("\n\na  \r\nb\t\rc\n\n"), "a\nb\nc");
});

test("examples/project is a valid manifest", async () => {
  const dir = new URL("../../examples/project/", import.meta.url).pathname;
  const project = await loadProject(dir);
  assert.equal(project?.manifest.name, "pi-agent");
});
