/** Separator pi puts between system prompt sections. */
const SEPARATOR = "\n\n";

/** Rough token count (4 characters per token), as elsewhere in pi-agent. */
const tokens = (text: string) => Math.ceil(text.length / 4);

export interface ContextView {
  /** Scenario announced by the scenario profile extension. */
  scenario?: string;
  /** `--project` manifest announced by the project extension. */
  project?: { name: string; dir: string };
  /** Active tools in order, with whether pi provides them. */
  tools: Array<{ name: string; builtin: boolean }>;
  /** pi's system prompt: the effective one after a prompt ran, pi's base one before. */
  systemPrompt: string;
  /** False before the first prompt: extensions have not changed the prompt yet. */
  built: boolean;
  /** Block B (project sections) as in the prompt; "" when there is none. */
  blockB: string;
}

const rule = (title: string) => `──── ${title} ${"─".repeat(Math.max(4, 60 - title.length))}`;

/**
 * Text for `/context`: what the session runs with (scenario, project, tools) and the full
 * system prompt, split at block B (the project sections, cached separately for Anthropic) when
 * it is found.
 */
export function formatContextView(v: ContextView): string {
  const tools = (builtin: boolean) => v.tools.filter((t) => t.builtin === builtin).map((t) => t.name);
  const lines = [
    rule("context setup"),
    `scenario: ${v.scenario ?? "(none, pi's default prompt)"}`,
    `project:  ${v.project ? `${v.project.name} (${v.project.dir})` : "(none)"}`,
    `tools (${v.tools.length}): built-in [${tools(true).join(", ")}] · extensions [${tools(false).join(", ")}]`,
  ];
  const at = v.built && v.blockB ? v.systemPrompt.indexOf(SEPARATOR + v.blockB) : -1;
  const a = at < 0 ? v.systemPrompt : v.systemPrompt.slice(0, at);
  const b = at < 0 ? "" : v.systemPrompt.slice(at + SEPARATOR.length);
  lines.push(
    `system prompt: ~${tokens(v.systemPrompt)} tokens` + (b ? ` (block A ~${tokens(a)}, block B ~${tokens(b)})` : ""),
  );
  if (!v.built) {
    lines.push(
      "Not built yet: this is pi's base prompt. Extensions (scenario, project, ...) change it when",
      "a prompt starts; send a message, then run /context again for the effective prompt.",
    );
  }
  const title = v.built ? "system prompt" : "system prompt (base)";
  lines.push("", rule(b ? `${title} · block A (shared)` : title), a);
  if (b) lines.push(rule("block B (project)"), b);
  lines.push(rule("end"));
  return lines.join("\n");
}
