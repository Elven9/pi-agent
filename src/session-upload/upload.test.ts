import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server } from "./test-server.ts";
import { loadUploadSettings, resolveHeaders, uploadSession, uploadUrl } from "./upload.ts";

async function tmpFile(name: string, content: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "pi-agent-upload-")), name);
  await writeFile(path, content);
  return path;
}

test("loadUploadSettings: missing file is off, invalid ones list every problem", async () => {
  assert.equal(await loadUploadSettings(join(tmpdir(), "pi-agent-no-such-settings.json")), undefined);
  const ok = await tmpFile("s.json", '{"machineId":"mac-1","endpoint":"https://x.example","headers":{"A":"$B"}}');
  assert.deepEqual(await loadUploadSettings(ok), { machineId: "mac-1", endpoint: "https://x.example", headers: { A: "$B" } });

  const bad = await tmpFile("s.json", '{"machineId":"my mac","endpoint":"ftp://x","token":"t"}');
  const err = await loadUploadSettings(bad).then(() => "", (e: Error) => e.message);
  assert.match(err, /\/machineId/);
  assert.match(err, /\/endpoint/);
  assert.match(err, /\/token is not a known key/);
  await assert.rejects(loadUploadSettings(await tmpFile("s.json", "{")), /Invalid .*s\.json/);
});

test("resolveHeaders: $NAME and ${NAME} from the environment, others literal", () => {
  const env = { ID: "id-1", SECRET: "s-2" };
  assert.deepEqual(resolveHeaders({ "CF-Access-Client-Id": "$ID", "CF-Access-Client-Secret": "${SECRET}", X: "plain $ID" }, env), {
    "CF-Access-Client-Id": "id-1",
    "CF-Access-Client-Secret": "s-2",
    X: "plain $ID",
  });
  assert.throws(() => resolveHeaders({ A: "$MISSING" }, env), /header A: environment variable MISSING is not set/);
});

test("uploadUrl joins the endpoint, machine id and session id", () => {
  const settings = { machineId: "mac-1", endpoint: "https://x.example/api/" };
  assert.equal(uploadUrl(settings, "abc-123"), "https://x.example/api/sessions/mac-1/abc-123");
});

test("uploadSession PUTs the raw file with the headers; non-2xx is an error", async () => {
  const file = await tmpFile("s.jsonl", '{"type":"session","id":"s1"}\n{"type":"message"}\n');
  const ok = await server(200);
  try {
    const bytes = await uploadSession({ machineId: "mac-1", endpoint: ok.endpoint, headers: { "CF-Access-Client-Id": "$ID" } }, "s1", file, {
      env: { ID: "id-1" },
    });
    assert.equal(bytes, 48);
    const [req] = ok.requests;
    assert.equal(req.method, "PUT");
    assert.equal(req.url, "/sessions/mac-1/s1");
    assert.equal(req.headers["cf-access-client-id"], "id-1");
    assert.equal(req.headers["content-type"], "application/x-ndjson");
    assert.equal(req.body, '{"type":"session","id":"s1"}\n{"type":"message"}\n');
  } finally {
    ok.close();
  }

  const denied = await server(403);
  try {
    await assert.rejects(
      uploadSession({ machineId: "m", endpoint: denied.endpoint }, "s1", file),
      /PUT http:\/\/127\.0\.0\.1:\d+\/sessions\/m\/s1 failed: HTTP 403: denied by test/,
    );
  } finally {
    denied.close();
  }
  await assert.rejects(uploadSession({ machineId: "m", endpoint: "http://127.0.0.1:9" }, "s1", file), /failed: /);
});
