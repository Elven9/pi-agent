import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideMcpServers, findExecutable, findUp, goplsConfig, mcpServerConfig } from "./mcp-servers.ts";

async function tree() {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-mcp-"));
  const mod = join(root, "mod");
  const sub = join(mod, "internal", "x");
  await mkdir(sub, { recursive: true });
  await writeFile(join(mod, "go.mod"), "module example.com/m\n");
  const bin = join(root, "bin");
  await mkdir(bin);
  return { root, mod, sub, bin };
}

async function fakeBin(dir: string, name: string) {
  const p = join(dir, name);
  await writeFile(p, "#!/bin/sh\n");
  await chmod(p, 0o755);
  return p;
}

test("findUp: nearest go.work/go.mod in the dir or an ancestor", async () => {
  const { root, mod, sub } = await tree();
  assert.equal(findUp(sub, ["go.work", "go.mod"]), join(mod, "go.mod"));
  await writeFile(join(root, "go.work"), "go 1.26\n");
  // The closest directory wins.
  assert.equal(findUp(sub, ["go.work", "go.mod"]), join(mod, "go.mod"));
  assert.equal(findUp(root, ["go.work", "go.mod"]), join(root, "go.work"));
});

test("findExecutable: PATH first, then extra dirs; skips non-executables", async () => {
  const { root, bin } = await tree();
  const other = join(root, "other");
  await mkdir(other);
  await writeFile(join(bin, "gopls"), "not executable");
  const extra = await fakeBin(other, "gopls");
  assert.equal(findExecutable("gopls", { PATH: bin }, [other]), extra);
  const onPath = await fakeBin(bin, "gopls");
  assert.equal(findExecutable("gopls", { PATH: bin }, [other]), onPath);
  assert.equal(findExecutable("gopls", { PATH: "" }), undefined);
});

test("gopls: skipped without a Go module", async () => {
  const { root, bin } = await tree();
  await fakeBin(bin, "gopls");
  const [d] = decideMcpServers(["gopls"], root, { env: { PATH: bin }, home: root });
  assert.equal(d.status, "skipped");
  assert.match(d.reason!, /no go\.mod/);
});

test("gopls: unavailable in a Go module without gopls", async () => {
  const { root, mod, sub } = await tree();
  const [d] = decideMcpServers(["gopls"], sub, { env: { PATH: "" }, home: root });
  assert.deepEqual({ ...d, reason: undefined }, { name: "gopls", status: "unavailable", root: join(mod, "go.mod"), reason: undefined });
  assert.match(d.reason!, /not installed/);
});

test("gopls: registered from PATH, GOBIN, GOPATH/bin or ~/go/bin", async () => {
  const { root, mod, sub, bin } = await tree();
  const onPath = await fakeBin(bin, "gopls");
  assert.deepEqual(decideMcpServers(["gopls"], sub, { env: { PATH: bin }, home: root }), [
    { name: "gopls", status: "registered", command: onPath, root: join(mod, "go.mod") },
  ]);
  const gopath = join(root, "gp");
  await mkdir(join(gopath, "bin"), { recursive: true });
  const inGopath = await fakeBin(join(gopath, "bin"), "gopls");
  assert.equal(decideMcpServers(["gopls"], sub, { env: { GOPATH: gopath }, home: root })[0].command, inGopath);
  await mkdir(join(root, "go", "bin"), { recursive: true });
  const inHome = await fakeBin(join(root, "go", "bin"), "gopls");
  assert.equal(decideMcpServers(["gopls"], sub, { env: {}, home: root })[0].command, inHome);
});

test("gopls config: codemode only, vulncheck hidden, runs in the workdir", () => {
  const c = goplsConfig("/bin/gopls", "/w");
  assert.deepEqual({ command: c.command, args: c.args, cwd: c.cwd, exposure: c.exposure, toolExposure: c.toolExposure }, {
    command: "/bin/gopls",
    args: ["mcp"],
    cwd: "/w",
    exposure: "codemode",
    toolExposure: { go_vulncheck: "hidden" },
  });
  assert.ok(c.timeout! > 60 && c.description);
  assert.deepEqual(mcpServerConfig({ name: "gopls", status: "registered", command: "/bin/gopls" }, "/w"), c);
});
