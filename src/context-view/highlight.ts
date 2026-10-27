import type { Theme } from "@earendil-works/pi-coding-agent";

/** The theme helpers the highlighter uses (the panel passes pi's theme). */
export type Styler = Pick<Theme, "fg" | "bold">;

/** Highlights a code block's lines; must return one line per input line (else it is ignored). */
export type CodeHighlighter = (code: string, lang: string | undefined) => string[];

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
/** An XML-style tag as prompts use them: `<skills>`, `</cwd>`, `<skill name="x">`, `<br/>`. */
const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w:.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/g;
const ATTR = /([\w:.-]+)(?:(\s*=\s*)("[^"]*"|'[^']*'))?/g;

/**
 * Syntax highlighting for a system prompt: Markdown with XML-style tags, as pi and the
 * scenarios write them. Tags (name, attributes, values), headings, list markers, inline code and
 * **bold**; fenced code blocks go to `code` with their language. Returns one styled line per
 * line of `text` (no wrapping).
 */
export function highlightPrompt(text: string, s: Styler, code: CodeHighlighter): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE.exec(lines[i]!);
    if (fence) {
      const marker = fence[1]!;
      const closing = new RegExp(`^\\s*\\${marker[0]}{${marker.length},}\\s*$`);
      const end = lines.findIndex((l, j) => j > i && closing.test(l));
      if (end > 0) {
        const body = lines.slice(i + 1, end);
        let styled = body.length > 0 ? code(body.join("\n"), fence[2] || undefined) : [];
        if (styled.length !== body.length) styled = body;
        out.push(s.fg("mdCodeBlockBorder", lines[i]!), ...styled, s.fg("mdCodeBlockBorder", lines[end]!));
        i = end;
        continue;
      }
    }
    out.push(highlightLine(lines[i]!, s));
  }
  return out;
}

function highlightLine(line: string, s: Styler): string {
  if (/^#{1,6}\s+\S/.test(line)) return s.bold(s.fg("mdHeading", line));
  const bullet = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(line);
  const prefix = bullet ? bullet[1]! + s.fg("mdListBullet", bullet[2]!) + bullet[3]! : "";
  const rest = bullet ? line.slice(bullet[0].length) : line;
  // Odd parts are inline code: no tags or bold inside.
  return prefix + rest.split(/(`[^`]+`)/).map((part, i) => (i % 2 === 1 ? s.fg("mdCode", part) : prose(part, s))).join("");
}

function prose(text: string, s: Styler): string {
  return text
    .replace(TAG, (_m, slash: string, name: string, attrs: string, self: string) => {
      const styledAttrs = attrs.replace(ATTR, (_a, key: string, eq: string | undefined, value: string | undefined) =>
        s.fg("syntaxVariable", key) + (value ? eq + s.fg("syntaxString", value) : ""),
      );
      return s.fg("syntaxPunctuation", `<${slash}`) + s.fg("syntaxKeyword", name) + styledAttrs + s.fg("syntaxPunctuation", `${self}>`);
    })
    .replace(/\*\*[^*\n]+\*\*/g, (m) => s.bold(m));
}
