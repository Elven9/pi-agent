import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCli } from "./project-source.ts";
import {
  excludePiFolder,
  expandHome,
  Git,
  isInside,
  parseWorktreeList,
  realpathNearest,
  removeEmptyParent,
  resolveWorktreeDir,
  seedSettings,
  workspaceRepos,
  worktreePath,
  worktreeSetting,
} from "./worktree.ts";

const git = new Git(execCli);
const exists = (p: string) => stat(p).then(() => true, () => false);

async function tmp(prefix = "pi-agent-wt-"): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/** A repository with one commit on `master`. */
async function makeRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  g("init", "-q", "-b", "master");
  g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

test("worktreeSetting: absent, valid, invalid", () => {
  assert.equal(worktreeSetting({}), undefined);
  assert.deepEqual(worktreeSetting({ worktree: { dir: "~/wt" } }), { dir: "~/wt" });
  assert.deepEqual(worktreeSetting({ worktree: {} }), {});
  assert.throws(() => worktreeSetting({ worktree: "x" }), /Invalid "worktree" in settings\.json:\n\/ must be an object/);
  assert.throws(() => worktreeSetting({ worktree: { path: "x" } }), /\/path is not a known key/);
  assert.throws(() => worktreeSetting({ worktree: { dir: "" } }), /\/dir/);
});

test("resolveWorktreeDir: project.worktreeDir, then worktree.dir, then .pi/worktree in the project folder or cwd", () => {
  const base = { cwd: "/w", home: "/h" };
  assert.equal(resolveWorktreeDir({ ...base, projectWorktreeDir: "/p/wt", settingDir: "/s", projectFolder: "/p" }), "/p/wt");
  assert.equal(resolveWorktreeDir({ ...base, settingDir: "~/wt", projectFolder: "/p" }), "/h/wt");
  assert.equal(resolveWorktreeDir({ ...base, settingDir: "wt", projectFolder: "/p" }), "/w/wt");
  assert.equal(resolveWorktreeDir({ ...base, projectFolder: "/p" }), "/p/.pi/worktree");
  assert.equal(resolveWorktreeDir(base), "/w/.pi/worktree");
  assert.equal(expandHome("~", "/h"), "/h");
  assert.equal(expandHome("~x", "/h"), "~x");
});

test("worktreePath and isInside", () => {
  assert.equal(worktreePath("/d", "/src/app", "feat/a/b"), "/d/app-wt/feat-a-b");
  assert.ok(isInside("/a/b", "/a"));
  assert.ok(isInside("/a", "/a"));
  assert.ok(!isInside("/ab", "/a"));
  assert.ok(!isInside("/", "/a"));
});

test("parseWorktreeList", () => {
  const list = parseWorktreeList(
    "worktree /r\nHEAD abc\nbranch refs/heads/master\n\nworktree /w\nHEAD def\ndetached\nlocked\n\nworktree /x\nHEAD 123\nbranch refs/heads/feat/x\nprunable gitdir file points to non-existent location\n",
  );
  assert.deepEqual(list.map((w) => [w.path, w.branch, w.detached, w.locked, w.prunable]), [
    ["/r", "master", false, false, false],
    ["/w", undefined, true, true, false],
    ["/x", "feat/x", false, false, true],
  ]);
});

test("realpathNearest: a missing tail is kept under the real parent", async () => {
  const dir = await tmp();
  assert.equal(await realpathNearest(join(dir, "a", "b.txt")), join(dir, "a", "b.txt"));
});

test("Git.add: new branch from HEAD or base, existing local branch, remote tracking branch; remove keeps the branch", async () => {
  const root = await tmp();
  const repo = await makeRepo(join(root, "app"));
  const dir = join(root, "wt");

  const p1 = worktreePath(dir, repo, "feat/one");
  assert.deepEqual(await git.add({ repo, branch: "feat/one", path: p1 }), { kind: "new", base: "HEAD" });
  assert.equal(execFileSync("git", ["-C", p1, "branch", "--show-current"], { encoding: "utf8" }).trim(), "feat/one");
  await assert.rejects(git.add({ repo, branch: "feat/one", path: p1 }), /already exists/);

  // Existing local branch.
  execFileSync("git", ["-C", repo, "branch", "fix/two"]);
  const p2 = worktreePath(dir, repo, "fix/two");
  assert.deepEqual(await git.add({ repo, branch: "fix/two", path: p2 }), { kind: "existing" });

  // Only on a remote: tracked.
  const clone = join(root, "clone");
  execFileSync("git", ["clone", "-q", repo, clone]);
  execFileSync("git", ["-C", repo, "branch", "feat/remote"]);
  execFileSync("git", ["-C", clone, "fetch", "-q"]);
  const p3 = worktreePath(dir, clone, "feat/remote");
  assert.deepEqual(await git.add({ repo: clone, branch: "feat/remote", path: p3 }), { kind: "tracking", remote: "origin/feat/remote" });

  // Explicit base.
  const p4 = worktreePath(dir, repo, "chore/four");
  assert.deepEqual(await git.add({ repo, branch: "chore/four", path: p4, base: "master" }), { kind: "new", base: "master" });

  const list = await git.list(repo);
  assert.deepEqual(list.map((w) => w.branch).sort(), ["chore/four", "feat/one", "fix/two", "master"]);
  assert.equal(list[0]!.path, repo);
  assert.equal(await git.mainCheckout(p1), repo);

  await git.remove(repo, p1);
  assert.ok(!(await exists(p1)));
  execFileSync("git", ["-C", repo, "show-ref", "--verify", "refs/heads/feat/one"]);
  // A worktree with changes is not removed.
  await writeFile(join(p2, "new.txt"), "x");
  await assert.rejects(git.remove(repo, p2));
});

test("Git: not a repository", async () => {
  const dir = await tmp();
  assert.equal(await git.isRepo(dir), false);
  await assert.rejects(git.mainCheckout(dir), /is not in a git repository/);
});

test("excludePiFolder: adds /.pi/ once", async () => {
  const repo = await makeRepo(join(await tmp(), "r"));
  const common = await git.commonDir(repo);
  assert.equal(await excludePiFolder(common), true);
  assert.equal(await excludePiFolder(common), false);
  const text = await readFile(join(common, "info", "exclude"), "utf8");
  assert.equal(text.split("\n").filter((l) => l === "/.pi/").length, 1);
});

test("seedSettings: copies the main checkout's (paths absolute), else writes this session's project, never overwrites", async () => {
  const root = await tmp();
  const main = join(root, "main");
  const wt = join(root, "wt");
  await mkdir(join(main, ".pi"), { recursive: true });
  await mkdir(wt);
  await writeFile(join(main, ".pi", "settings.json"), JSON.stringify({ project: { type: "local", dir: "../proj" }, theme: "dark" }));
  assert.equal(await seedSettings({ main, worktree: wt, cwd: "/elsewhere" }), "copied");
  assert.deepEqual(JSON.parse(await readFile(join(wt, ".pi", "settings.json"), "utf8")), {
    project: { type: "local", dir: join(root, "proj") },
    theme: "dark",
  });
  assert.equal(await seedSettings({ main, worktree: wt, cwd: "/elsewhere" }), "exists");

  const wt2 = join(root, "wt2");
  await mkdir(wt2);
  const project = { type: "github" as const, repo: "https://github.com/a/b", tag: "v1", worktreeDir: "wt" };
  assert.equal(await seedSettings({ main: join(root, "none"), worktree: wt2, project, cwd: "/c" }), "written");
  assert.deepEqual(JSON.parse(await readFile(join(wt2, ".pi", "settings.json"), "utf8")), { project: { ...project, worktreeDir: "/c/wt" } });

  const wt3 = join(root, "wt3");
  await mkdir(wt3);
  assert.equal(await seedSettings({ main: join(root, "none"), worktree: wt3, cwd: "/c" }), "none");
});

test("removeEmptyParent: only an empty <repo>-wt folder", async () => {
  const root = await tmp();
  await mkdir(join(root, "app-wt"));
  await removeEmptyParent(join(root, "app-wt", "feat-x"));
  assert.ok(!(await exists(join(root, "app-wt"))));
  await mkdir(join(root, "other"));
  await removeEmptyParent(join(root, "other", "x"));
  assert.ok(await exists(join(root, "other")));
});

test("workspaceRepos: the cwd's repository and the repositories in its subfolders", async () => {
  const root = await makeRepo(await tmp());
  const a = await makeRepo(join(root, "a"));
  await mkdir(join(root, "plain"));
  const b = await makeRepo(join(root, "b"));
  assert.deepEqual(await workspaceRepos(git, root), [root, a, b]);
  assert.deepEqual(await workspaceRepos(git, join(root, "plain")), [root]);
  const outside = await tmp();
  assert.deepEqual(await workspaceRepos(git, outside), []);
});
