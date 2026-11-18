import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Marks our editor factory, so a /reload does not wrap it again (and reset the editor). */
const MARK = "piAgentTagsCommaTrigger";

/**
 * Whether typing a comma should open `/tags` completion: the line is a `/tags` command and
 * the text before the cursor ends with the comma just typed (spaces after it allowed).
 */
export function commaOpensCompletion(textBeforeCursor: string): boolean {
  return /^\s*\/tags\s(?:.*),\s*$/.test(textBeforeCursor);
}

/** The editor parts used here; `tryTriggerAutocomplete` is private in pi-tui (checked at runtime). */
interface EditorLike {
  handleInput(data: string): void;
  getLines(): string[];
  getCursor(): { line: number; col: number };
  isShowingAutocomplete?(): boolean;
  tryTriggerAutocomplete?(explicitTab?: boolean): void;
}

/**
 * pi's editor opens completion on letters and digits, not on `,`, so after picking a tag and
 * typing a comma the menu stays closed until the next letter. This wraps the editor (pi's own,
 * or a custom one another extension set) to open it on a comma in `/tags`. Installed once per
 * pi process, in the interactive UI only.
 */
export function installCommaTrigger(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const previous = ctx.ui.getEditorComponent();
  if (previous && (previous as unknown as Record<string, unknown>)[MARK]) return;
  const factory: NonNullable<typeof previous> = (tui, theme, keybindings) => {
    const editor = previous ? previous(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
    const e = editor as unknown as EditorLike;
    if (typeof e.tryTriggerAutocomplete !== "function" || typeof e.getCursor !== "function") return editor;
    const handle = e.handleInput.bind(editor);
    e.handleInput = (data: string) => {
      handle(data);
      if (!data.includes(",") || e.isShowingAutocomplete?.()) return;
      const { line, col } = e.getCursor();
      if (commaOpensCompletion((e.getLines()[line] ?? "").slice(0, col))) e.tryTriggerAutocomplete?.();
    };
    return editor;
  };
  Object.defineProperty(factory, MARK, { value: true });
  ctx.ui.setEditorComponent(factory);
}
