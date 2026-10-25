import { test } from "node:test";
import assert from "node:assert/strict";
import { CliError, parseRepo, projectFolder, projectPath, projectSetting, remoteSource, type CliRunner } from "./project-source.ts";
import { loadProjectFrom, renderProjectSections } from "./project.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const b64 = (s: string) => Buffer.from(s).toString("base64");
const notFound = () => new CliError("failed", "404 Not Found");

/** A runner answering from a table: "cmd endpoint [extra...]" → stdout or an error. */
function table(answers: Record<string, string | Error>, calls: string[] = []): CliRunner {
  return async (command, args) => {
    // args: api --hostname <host> <endpoint> [...]
    const key = [command, ...args.slice(3)].join(" ");
    calls.push(key);
    const answer = answers[key];
    if (answer === undefined) throw notFound();
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

test("projectSetting: absent, valid, and every kind of invalid", () => {
  assert.equal(projectSetting({}), undefined);
  assert.equal(projectSetting(undefined), undefined);
  const ok = { repo: "https://github.com/acme/proj.git", provider: "github", tag: "v1" };
  assert.deepEqual(projectSetting({ project: ok }), ok);
  assert.throws(() => projectSetting({ project: { ...ok, branch: "main" } }), /\/branch is not a known key/);
  assert.throws(() => projectSetting({ project: { ...ok, provider: "bitbucket" } }), /\/provider/);
  assert.throws(() => projectSetting({ project: { ...ok, repo: "acme/proj" } }), /\/repo must be a repository URL/);
  assert.throws(() => projectSetting({ project: { ...ok, repo: "ssh://git@github.com/acme/proj" } }), /http\(s\) URL/);
  assert.throws(() => projectSetting({ project: { ...ok, repo: "https://github.com/acme" } }), /<owner>\/<repo> for GitHub/);
  assert.throws(() => projectSetting({ project: { ...ok, repo: "https://x:y@github.com/acme/proj" } }), /credentials/);
});

test("parseRepo: host and path; GitLab allows subgroups", () => {
  assert.deepEqual(parseRepo({ repo: "https://github.com/acme/proj.git/", provider: "github", tag: "v1" }), {
    repo: "https://github.com/acme/proj",
    host: "github.com",
    repoPath: "acme/proj",
  });
  assert.deepEqual(parseRepo({ repo: "https://gitlab.example.com:8443/g/sub/proj", provider: "gitlab", tag: "v1" }), {
    repo: "https://gitlab.example.com:8443/g/sub/proj",
    host: "gitlab.example.com:8443",
    repoPath: "g/sub/proj",
  });
});

test("projectPath keeps paths inside the project", () => {
  assert.equal(projectPath("docs/a.md"), "docs/a.md");
  assert.equal(projectPath("./docs//a.md"), "docs/a.md");
  assert.equal(projectPath("docs/../b.md"), "b.md");
  for (const bad of ["/etc/passwd", "../x", "..", ".", "docs/../../x"]) assert.equal(projectPath(bad), undefined, bad);
});

test("GitHub: pins the tag to a commit, reads files at it, caches, handles directories and big files", async () => {
  const calls: string[] = [];
  const contents = (path: string) => `repos/acme/proj/contents/${path}?ref=${COMMIT}`;
  const run = table(
    {
      "gh repos/acme/proj/commits/refs/tags/release/1 --jq .sha": `${COMMIT}\n`,
      [`gh ${contents("a%20b.md")}`]: JSON.stringify({ type: "file", encoding: "base64", content: b64("hé") }),
      [`gh ${contents("docs")}`]: JSON.stringify([{ name: "x.md" }]),
      [`gh ${contents("big.md")}`]: JSON.stringify({ type: "file", encoding: "none", content: "" }),
      [`gh ${contents("big.md")} -H Accept: application/vnd.github.raw`]: "BIG",
    },
    calls,
  );
  const source = await remoteSource({ repo: "https://github.com/acme/proj", provider: "github", tag: "release/1" }, run);
  assert.equal(source.kind, "remote");
  assert.equal(source.label, "https://github.com/acme/proj@release/1");
  assert.deepEqual(source.remote, {
    provider: "github", repo: "https://github.com/acme/proj", host: "github.com", repoPath: "acme/proj", tag: "release/1", commit: COMMIT,
  });
  assert.equal(await source.read("a b.md"), "hé");
  assert.equal(await source.read("a b.md"), "hé");
  assert.equal(calls.filter((c) => c.includes("a%20b.md")).length, 1);
  assert.equal(await source.read("docs"), undefined);
  assert.equal(await source.read("missing.md"), undefined);
  assert.equal(await source.read("big.md"), "BIG");
});

test("GitHub: other failures throw (and are retried), a missing tag says so", async () => {
  let fail = true;
  const run: CliRunner = async (_c, args) => {
    if (args[3].includes("/commits/")) return COMMIT;
    if (fail) throw new CliError("gh api failed: HTTP 401", "gh: Bad credentials (HTTP 401)");
    return JSON.stringify({ type: "file", encoding: "base64", content: b64("ok") });
  };
  const source = await remoteSource({ repo: "https://github.com/acme/proj", provider: "github", tag: "v1" }, run);
  await assert.rejects(source.read("a.md"), /Cannot read a\.md from https:\/\/github\.com\/acme\/proj@v1: .*401/);
  fail = false;
  assert.equal(await source.read("a.md"), "ok");

  const noTag = table({ "gh repos/acme/proj/commits/refs/tags/v2 --jq .sha": new CliError("x", "gh: No commit found (HTTP 422)") });
  await assert.rejects(
    remoteSource({ repo: "https://github.com/acme/proj", provider: "github", tag: "v2" }, noTag),
    /Cannot open project https:\/\/github\.com\/acme\/proj@v2 with gh \(logged in\? `gh auth status --hostname github\.com`\): tag v2 not found/,
  );
});

test("GitLab: URL-encoded project and file paths, tag commit, base64 content", async () => {
  const project = "projects/g%2Fsub%2Fproj";
  const run = table({
    [`glab ${project}/repository/tags/v1.2`]: JSON.stringify({ name: "v1.2", commit: { id: COMMIT } }),
    [`glab ${project}/repository/files/project.yaml?ref=${COMMIT}`]: JSON.stringify({
      encoding: "base64",
      content: b64("version: 1\nname: gl\nworkflows:\n  - path: wf/release.md\n    when: Releasing.\n"),
    }),
    [`glab ${project}/repository/files/wf%2Frelease.md?ref=${COMMIT}`]: JSON.stringify({ encoding: "base64", content: b64("1. Tag\n") }),
  });
  const source = await remoteSource({ repo: "https://gitlab.example.com/g/sub/proj", provider: "gitlab", tag: "v1.2" }, run);
  const project_ = await loadProjectFrom(source);
  assert.equal(project_!.dir, undefined);
  assert.equal(await source.read("wf/release.md"), "1. Tag\n");
  const sections = renderProjectSections({ cwd: "/sandbox", project: project_ });
  assert.equal(
    sections.project_workflows,
    "Before doing one of these tasks, read its file with the project_read tool and follow the steps in order. " +
      "If several apply, follow them one after another, finishing each before starting the next:\n- wf/release.md: Releasing.",
  );
});

test("remote project: a listed file missing from the repo is reported", async () => {
  const run = table({
    "gh repos/acme/proj/commits/refs/tags/v1 --jq .sha": COMMIT,
    [`gh repos/acme/proj/contents/project.yaml?ref=${COMMIT}`]: JSON.stringify({
      type: "file", encoding: "base64", content: b64("version: 1\nname: x\ndocs:\n  - path: docs/gone.md\n    when: Never.\n"),
    }),
  });
  const source = await remoteSource({ repo: "https://github.com/acme/proj", provider: "github", tag: "v1" }, run);
  await assert.rejects(loadProjectFrom(source), /Invalid project\.yaml in https:\/\/github\.com\/acme\/proj@v1:\n\/docs\/0\/path: docs\/gone\.md is not a file/);
  const empty = await remoteSource({ repo: "https://github.com/acme/proj", provider: "github", tag: "v1" }, table({ "gh repos/acme/proj/commits/refs/tags/v1 --jq .sha": COMMIT }));
  await assert.rejects(loadProjectFrom(empty), /Cannot read project\.yaml in https:\/\/github\.com\/acme\/proj@v1: no such file/);
});

test("project folder (path): normalized, root by default, must stay inside the repo", () => {
  const base = { repo: "https://github.com/acme/mono", provider: "github" as const, tag: "v1" };
  assert.equal(projectFolder(base), undefined);
  assert.equal(projectFolder({ ...base, path: "." }), undefined);
  assert.equal(projectFolder({ ...base, path: "/" }), undefined);
  assert.equal(projectFolder({ ...base, path: "./projects/billing/" }), "projects/billing");
  assert.throws(() => projectSetting({ project: { ...base, path: "../other" } }), /\/path \.\.\/other must be a folder inside the repository/);
  assert.throws(() => projectSetting({ project: { ...base, path: "/abs/dir" } }), /\/path/);
  assert.deepEqual(projectSetting({ project: { ...base, path: "projects/billing" } }), { ...base, path: "projects/billing" });
});

test("project folder: every read (project.yaml, checks, project_read) is under it; paths in the prompt stay relative", async () => {
  const calls: string[] = [];
  const gh = table(
    {
      "gh repos/acme/mono/commits/refs/tags/v1 --jq .sha": COMMIT,
      [`gh repos/acme/mono/contents/projects/billing/project.yaml?ref=${COMMIT}`]: JSON.stringify({
        type: "file", encoding: "base64", content: b64("version: 1\nname: billing\ndocs:\n  - path: docs/a.md\n    when: Always.\n"),
      }),
      [`gh repos/acme/mono/contents/projects/billing/docs/a.md?ref=${COMMIT}`]: JSON.stringify({ type: "file", encoding: "base64", content: b64("A") }),
    },
    calls,
  );
  const source = await remoteSource({ repo: "https://github.com/acme/mono", provider: "github", tag: "v1", path: "projects/billing/" }, gh);
  assert.equal(source.label, "https://github.com/acme/mono/projects/billing@v1");
  assert.equal(source.remote!.path, "projects/billing");
  const project = await loadProjectFrom(source);
  assert.equal(await source.read("docs/a.md"), "A");
  assert.equal(calls.filter((c) => c.includes("docs/a.md")).length, 1);
  assert.match(renderProjectSections({ cwd: "/sandbox", project }).project_docs, /\n- docs\/a\.md: Always\.$/);

  const gl = table({
    "glab projects/g%2Fmono/repository/tags/v1": JSON.stringify({ commit: { id: COMMIT } }),
    [`glab projects/g%2Fmono/repository/files/projects%2Fpay%2Fproject.yaml?ref=${COMMIT}`]: JSON.stringify({ encoding: "base64", content: b64("version: 1\nname: pay\n") }),
  });
  const glSource = await remoteSource({ repo: "https://gitlab.example.com/g/mono", provider: "gitlab", tag: "v1", path: "projects/pay" }, gl);
  assert.equal((await loadProjectFrom(glSource))!.manifest.name, "pay");
});
