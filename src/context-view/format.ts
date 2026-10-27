/** Separator pi puts between system prompt sections. */
export const SEPARATOR = "\n\n";

/** Rough token count (4 characters per token), as elsewhere in pi-agent. */
export const tokens = (text: string) => Math.ceil(text.length / 4);

/** A named part of the recorded prompt, in prompt order (pi's `SystemMessage.sections`). */
export interface PromptSection {
  name: string;
  text: string;
}

export interface ContextView {
  /** Scenario announced by the scenario profile extension. */
  scenario?: string;
  /** `--project` manifest announced by the project extension. */
  project?: { name: string; dir: string };
  /** Active tools in order, with whether pi provides them. */
  tools: Array<{ name: string; builtin: boolean }>;
  /** The model's system prompt as recorded in the session; pi's base one before the first prompt. */
  systemPrompt: string;
  /** False before the first prompt: nothing recorded, `systemPrompt` is pi's base prompt. */
  built: boolean;
  /** Block B (project sections) as in the prompt; "" when there is none. */
  blockB: string;
  /** The recorded prompt's sections (joined by SEPARATOR they are `systemPrompt`); none before the first prompt. */
  sections?: PromptSection[];
  /** Names of the sections that make up block B (from the project extension). */
  blockBSections?: string[];
}

/** Whether a recorded section is part of block B. */
export function inBlockB(v: ContextView, section: PromptSection): boolean {
  return v.blockBSections ? v.blockBSections.includes(section.name) : v.blockB !== "" && v.blockB.includes(section.text);
}

/** Block A and B text sizes, or undefined when the prompt has no block B. */
function blockSizes(v: ContextView): { a: number; b: number } | undefined {
  const b = v.built && v.sections ? v.sections.filter((s) => inBlockB(v, s)) : [];
  if (v.sections && b.length > 0) {
    const join = (list: PromptSection[]) => list.map((s) => s.text).join(SEPARATOR);
    return { a: tokens(join(v.sections.filter((s) => !inBlockB(v, s)))), b: tokens(join(b)) };
  }
  // No recorded section is block B (e.g. a prompt recorded as plain content): split the text.
  const at = blockBStart(v);
  return at < 0 ? undefined : { a: tokens(v.systemPrompt.slice(0, at)), b: tokens(v.systemPrompt.slice(at + SEPARATOR.length)) };
}

/** Where block B starts in the prompt, or -1 (not built, no project, or not found). */
export function blockBStart(v: ContextView): number {
  return v.built && v.blockB ? v.systemPrompt.indexOf(SEPARATOR + v.blockB) : -1;
}

/** The setup lines: scenario, project, tools and the prompt size. */
export function contextHeader(v: ContextView): string[] {
  const tools = (builtin: boolean) => v.tools.filter((t) => t.builtin === builtin).map((t) => t.name);
  const blocks = blockSizes(v);
  const size = `system prompt: ~${tokens(v.systemPrompt)} tokens` + (blocks ? ` (block A ~${blocks.a}, block B ~${blocks.b})` : "");
  return [
    `scenario: ${v.scenario ?? "(none, pi's default prompt)"}`,
    `project:  ${v.project ? `${v.project.name} (${v.project.dir})` : "(none)"}`,
    `tools (${v.tools.length}): built-in [${tools(true).join(", ")}] · extensions [${tools(false).join(", ")}]`,
    size,
  ];
}

/** Shown before the first prompt, when the view has pi's base prompt. */
export const NOT_BUILT_NOTE = [
  "Not built yet: this is pi's base prompt. Extensions (scenario, project, ...) change it when",
  "a prompt starts; send a message, then run /context again for the effective prompt.",
];

const rule = (title: string) => `──── ${title} ${"─".repeat(Math.max(4, 60 - title.length))}`;

/**
 * Text for `/context`: what the session runs with (scenario, project, tools) and the full
 * system prompt, split at block B (the project sections, cached separately for Anthropic) when
 * it is found.
 */
export function formatContextView(v: ContextView): string {
  const lines = [rule("context setup"), ...contextHeader(v)];
  const at = blockBStart(v);
  const a = at < 0 ? v.systemPrompt : v.systemPrompt.slice(0, at);
  const b = at < 0 ? "" : v.systemPrompt.slice(at + SEPARATOR.length);
  if (!v.built) lines.push(...NOT_BUILT_NOTE);
  const title = v.built ? "system prompt (last sent)" : "system prompt (base)";
  lines.push("", rule(b ? `${title} · block A (shared)` : title), a);
  if (b) lines.push(rule("block B (project)"), b);
  lines.push(rule("end"));
  return lines.join("\n");
}
