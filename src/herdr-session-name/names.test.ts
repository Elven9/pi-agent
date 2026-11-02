import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_NAME_MAX, displayName, paneSuffix, shortLabel, slug, withSuffix } from "./names.ts";

const VALID = /^[a-z][a-z0-9_-]{0,31}$/;

test("slug: lowercase, punctuation and spaces become single dashes", () => {
  assert.equal(slug("Refactor auth module"), "refactor-auth-module");
  assert.equal(slug("Fix: the  API / v2!"), "fix-the-api-v2");
  assert.equal(slug("a - b"), "a-b");
  assert.equal(slug("keep_under_score"), "keep_under_score");
});

test("slug: starts with a letter, no trailing dash", () => {
  assert.equal(slug("123 go"), "go");
  assert.equal(slug("--_x"), "x");
  assert.equal(slug("done!"), "done");
});

test("slug: nothing usable gives an empty string", () => {
  for (const name of ["日本語", "!!!", "123", "", "   "]) assert.equal(slug(name), "", name);
  assert.equal(slug("修复 login bug"), "login-bug");
});

test("slug: at most 32 characters, still valid after the cut", () => {
  const s = slug("a very long session name that goes well past the herdr limit");
  assert.ok(s.length <= AGENT_NAME_MAX);
  assert.match(s, VALID);
  assert.equal(slug("abcdefghij abcdefghij abcdefghij-x"), "abcdefghij-abcdefghij-abcdefghij");
  assert.equal(slug("abcdefghij abcdefghij abcdefghi xyz"), "abcdefghij-abcdefghij-abcdefghi");
});

test("paneSuffix: pane id as a slug part", () => {
  assert.equal(paneSuffix("wD:p1"), "wd-p1");
  assert.equal(paneSuffix(":A::b:"), "a-b");
});

test("withSuffix: fits in 32 characters and stays valid", () => {
  assert.equal(withSuffix("refactor-auth", "wd-p1"), "refactor-auth-wd-p1");
  const long = withSuffix(slug("x".repeat(40)), "wd-p1");
  assert.equal(long.length, AGENT_NAME_MAX);
  assert.match(long, VALID);
  assert.equal(withSuffix("abcdefghijklmnopqrstuvwxy-z", "wd-p1"), "abcdefghijklmnopqrstuvwxy-wd-p1");
  assert.equal(withSuffix("", "wd-p1"), "");
  assert.equal(withSuffix("abc", ""), "");
  assert.equal(withSuffix("abc", "s".repeat(31)), "");
});

test("shortLabel: up to 24 characters unchanged, longer cut with an ellipsis", () => {
  assert.equal(shortLabel("  Refactor auth  "), "Refactor auth");
  assert.equal(shortLabel("x".repeat(24)), "x".repeat(24));
  const cut = shortLabel("Refactor the authentication module");
  assert.equal(cut, "Refactor the authentica…");
  assert.equal(Array.from(cut).length, 24);
  assert.equal(shortLabel("😀".repeat(30)), "😀".repeat(23) + "…");
});

test("displayName: trimmed, at most 80 characters", () => {
  assert.equal(displayName("  Refactor auth module "), "Refactor auth module");
  assert.equal(displayName("y".repeat(100)).length, 80);
});
