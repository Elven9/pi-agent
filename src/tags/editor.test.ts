import { test } from "node:test";
import assert from "node:assert/strict";
import { commaOpensCompletion, installCommaTrigger } from "./editor.ts";

test("commaOpensCompletion: only right after a comma in /tags", () => {
  assert.equal(commaOpensCompletion("/tags bug,"), true);
  assert.equal(commaOpensCompletion("  /tags bug, ui, "), true);
  assert.equal(commaOpensCompletion("/tags bug,u"), false);
  assert.equal(commaOpensCompletion("/tags"), false);
  assert.equal(commaOpensCompletion("/tagsx a,"), false);
  assert.equal(commaOpensCompletion("hello, world,"), false);
});

/** A stand-in editor: typing appends to one line; records completion triggers. */
function fakeEditor(showing = false) {
  const e = {
    text: "",
    triggers: 0,
    handleInput(data: string) {
      e.text += data;
    },
    getLines: () => [e.text],
    getCursor: () => ({ line: 0, col: e.text.length }),
    isShowingAutocomplete: () => showing,
    tryTriggerAutocomplete() {
      e.triggers++;
    },
  };
  return e;
}

function install(previous: () => unknown) {
  let factory: any;
  const ctx = { mode: "tui", ui: { getEditorComponent: () => previous, setEditorComponent: (f: any) => (factory = f) } } as any;
  installCommaTrigger(ctx);
  return factory;
}

test("installCommaTrigger: a comma in /tags opens completion on the wrapped editor", () => {
  const inner = fakeEditor();
  const editor = install(() => inner)({}, {}, {});
  assert.equal(editor, inner);
  for (const ch of "/tags bug") editor.handleInput(ch);
  assert.equal(inner.triggers, 0);
  editor.handleInput(",");
  assert.equal(inner.triggers, 1);
  for (const ch of "hi,") fakeEditor().handleInput(ch);
  const open = fakeEditor(true);
  const wrapped = install(() => open)({}, {}, {});
  for (const ch of "/tags a,") wrapped.handleInput(ch);
  assert.equal(open.triggers, 0); // already showing: pi updates it itself
});

test("installCommaTrigger: an editor without the private trigger is left as is", () => {
  const plain = { handleInput() {}, getLines: () => [""], getCursor: () => ({ line: 0, col: 0 }) };
  const editor = install(() => plain)({}, {}, {});
  assert.equal(editor, plain);
  assert.equal(editor.handleInput, plain.handleInput);
});
