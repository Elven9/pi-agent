import { test } from "node:test";
import assert from "node:assert/strict";
import type { Herdr, HerdrResult } from "./herdr.ts";
import { createSync, MAX_RETRIES } from "./sync.ts";

type Call = [string, ...unknown[]];

/**
 * A fake Herdr: records calls in order, answers from `reply` (ok by default). With `hold`,
 * every call waits for `release()`, to test what happens while a sync is running.
 */
function fakeHerdr(reply: (call: Call) => HerdrResult = () => ({ ok: true }), o: { hold?: boolean } = {}) {
  const calls: Call[] = [];
  const seqs: number[] = [];
  let active = 0;
  let maxActive = 0;
  let waiting: Array<() => void> = [];
  const call = async (c: Call): Promise<HerdrResult> => {
    calls.push(c);
    active++;
    maxActive = Math.max(maxActive, active);
    if (o.hold) await new Promise<void>((resolve) => waiting.push(resolve));
    else await Promise.resolve();
    active--;
    return reply(c);
  };
  const herdr: Herdr = {
    renamePane: (label) => call(["pane", label ?? null]),
    renameAgent: (name) => call(["agent", name ?? null]),
    displayAgent: (name, seq) => {
      seqs.push(seq);
      return call(["display", name ?? null]);
    },
  };
  return {
    herdr,
    calls,
    seqs,
    get maxActive() {
      return maxActive;
    },
    release() {
      const w = waiting;
      waiting = [];
      for (const resolve of w) resolve();
    },
  };
}

/** Lets held calls through until the sync is idle. */
async function settle(f: ReturnType<typeof fakeHerdr>, sync: ReturnType<typeof createSync>) {
  for (let i = 0; i < 50; i++) {
    f.release();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await sync.idle();
}

const SET: Call[] = [
  ["pane", "Refactor auth module"],
  ["display", "Refactor auth module"],
  ["agent", "refactor-auth-module"],
];
const CLEAR: Call[] = [
  ["pane", null],
  ["agent", null],
  ["display", null],
];

test("a name sets all three: short label, full display name, slug", async () => {
  const f = fakeHerdr();
  const sync = createSync(f.herdr, "wD:p1");
  sync.request("Refactor auth module");
  await sync.idle();
  assert.deepEqual(f.calls, SET);
  assert.equal(sync.failed, false);

  const g = fakeHerdr();
  const long = createSync(g.herdr, "wD:p1");
  long.request("Refactor the authentication module");
  await long.idle();
  assert.deepEqual(g.calls[0], ["pane", "Refactor the authentica…"]);
  assert.deepEqual(g.calls[1], ["display", "Refactor the authentication module"]);
});

test("no name (or a blank one) clears all three", async () => {
  for (const name of [undefined, "   "]) {
    const f = fakeHerdr();
    const sync = createSync(f.herdr, "p");
    sync.request(name);
    await sync.idle();
    assert.deepEqual(f.calls, CLEAR, String(name));
  }
});

test("a name without a usable slug sets label and display, clears the agent name", async () => {
  const f = fakeHerdr();
  const sync = createSync(f.herdr, "p");
  sync.request("日本語");
  await sync.idle();
  assert.deepEqual(f.calls, [
    ["pane", "日本語"],
    ["display", "日本語"],
    ["agent", null],
  ]);
  assert.equal(sync.failed, false);
});

test("latest wins: calls never overlap, a queued name is replaced by a newer one", async () => {
  const f = fakeHerdr(undefined, { hold: true });
  const sync = createSync(f.herdr, "p");
  sync.request("first");
  sync.request("second"); // queued behind "first"
  sync.request("third"); // replaces "second"
  await settle(f, sync);
  assert.equal(f.maxActive, 1);
  assert.deepEqual(
    f.calls.map((c) => c[1]),
    ["first", "first", "first", "third", "third", "third"],
  );
});

test("report-metadata seq grows across calls and starts from the clock", async () => {
  const before = Date.now() * 1000;
  const f = fakeHerdr();
  const sync = createSync(f.herdr, "p");
  sync.request("a");
  await sync.idle();
  sync.request(undefined);
  await sync.idle();
  assert.equal(f.seqs.length, 2);
  assert.ok(f.seqs[0]! > before);
  assert.ok(f.seqs[1]! > f.seqs[0]!);
});

test("name taken: retried with the pane suffix", async () => {
  const f = fakeHerdr((c) => (c[0] === "agent" && c[1] === "refactor" ? { ok: false, code: "agent_name_taken" } : { ok: true }));
  const sync = createSync(f.herdr, "wD:p1");
  sync.request("Refactor");
  await sync.idle();
  assert.deepEqual(f.calls.slice(2), [
    ["agent", "refactor"],
    ["agent", "refactor-wd-p1"],
  ]);
  assert.equal(sync.failed, false);
});

test("other agent rename failures: no suffix retry, marked failed", async () => {
  const f = fakeHerdr((c) => (c[0] === "agent" ? { ok: false, code: "agent_not_found" } : { ok: true }));
  const sync = createSync(f.herdr, "p");
  sync.request("x");
  await sync.idle();
  assert.deepEqual(f.calls.filter((c) => c[0] === "agent"), [["agent", "x"]]);
  assert.equal(sync.failed, true);
});

test("generic retry: any failed step re-runs the whole sync, up to MAX_RETRIES", async () => {
  for (const step of ["pane", "display", "agent"]) {
    let failing = true;
    const f = fakeHerdr((c) => (failing && c[0] === step ? { ok: false } : { ok: true }));
    const sync = createSync(f.herdr, "p");
    sync.request("Name");
    await sync.idle();
    assert.equal(sync.failed, true, step);
    failing = false;
    sync.retry();
    await sync.idle();
    assert.equal(f.calls.length, 6, step);
    assert.deepEqual(f.calls.slice(3), f.calls.slice(0, 3), step);
    assert.equal(sync.failed, false, step);
    sync.retry(); // nothing failed: no calls
    await sync.idle();
    assert.equal(f.calls.length, 6, step);
  }

  const f = fakeHerdr((c) => (c[0] === "pane" ? { ok: false } : { ok: true }));
  const sync = createSync(f.herdr, "p");
  sync.request("Name");
  await sync.idle();
  for (let i = 0; i < MAX_RETRIES + 2; i++) {
    sync.retry();
    await sync.idle();
  }
  assert.equal(f.calls.length, 3 * (1 + MAX_RETRIES));
  sync.request("Name"); // a new request resets the retry budget
  await sync.idle();
  sync.retry();
  await sync.idle();
  assert.equal(f.calls.length, 3 * (3 + MAX_RETRIES));
});

test("a failed clear is retried; gone panes and agents count as cleared", async () => {
  const gone = fakeHerdr((c) => (c[0] === "agent" ? { ok: false, code: "agent_not_found" } : { ok: true }));
  const a = createSync(gone.herdr, "p");
  a.request(undefined);
  await a.idle();
  assert.equal(a.failed, false);

  const broken = fakeHerdr((c) => (c[0] === "display" ? { ok: false } : { ok: true }));
  const b = createSync(broken.herdr, "p");
  b.request(undefined);
  await b.idle();
  assert.equal(b.failed, true);
  b.retry();
  await b.idle();
  assert.deepEqual(broken.calls, [...CLEAR, ...CLEAR]);
});

test("shutdown: drops queued work, waits for the running sync, then clears all three", async () => {
  const f = fakeHerdr(undefined, { hold: true });
  const sync = createSync(f.herdr, "p");
  sync.request("running");
  sync.request("queued");
  const done = sync.shutdown();
  sync.request("after shutdown"); // ignored
  sync.retry(); // ignored
  let finished = false;
  void done.then(() => (finished = true));
  for (let i = 0; i < 50 && !finished; i++) {
    f.release();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(finished, true);
  assert.deepEqual(f.calls, [
    ["pane", "running"],
    ["display", "running"],
    ["agent", "running"],
    ...CLEAR,
  ]);
});

test("shutdown: an unnamed session still clears (the previous runtime may have set names)", async () => {
  const f = fakeHerdr();
  const sync = createSync(f.herdr, "p");
  await sync.shutdown();
  assert.deepEqual(f.calls, CLEAR);
});

test("shutdown is capped when herdr hangs", async () => {
  const f = fakeHerdr(undefined, { hold: true }); // never released
  const sync = createSync(f.herdr, "p", { shutdownCapMs: 20 });
  sync.request("stuck");
  const started = Date.now();
  await sync.shutdown();
  assert.ok(Date.now() - started < 1000);
  f.release();
});
