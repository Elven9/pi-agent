/**
 * How a pi session name maps to the three herdr names (see index.ts): the pane label (shortened),
 * the agent name (a slug herdr accepts) and the sidebar display name (the full name, capped).
 */

/** herdr agent names: `[a-z][a-z0-9_-]{0,31}`. */
export const AGENT_NAME_MAX = 32;
/** Pane labels sit in narrow pane borders. */
export const LABEL_MAX = 24;
/** herdr's limit for `--display-agent`. */
export const DISPLAY_MAX = 80;

/** Cut by code points, so a surrogate pair is never split. */
const cut = (text: string, max: number) => Array.from(text).slice(0, max).join("");

/** The pane label: the trimmed name, cut to LABEL_MAX with a trailing "…". */
export function shortLabel(name: string, max = LABEL_MAX): string {
  const text = name.trim();
  return Array.from(text).length > max ? cut(text, max - 1) + "…" : text;
}

/** The sidebar display name: the trimmed name, cut to DISPLAY_MAX. */
export function displayName(name: string): string {
  return cut(name.trim(), DISPLAY_MAX).trim();
}

const trimDashes = (s: string) => s.replace(/-+$/, "");

/**
 * An agent name herdr accepts: lowercase, runs of other characters become one "-", starts with
 * a letter, at most `max` characters, no trailing "-". "" when nothing usable is left
 * (e.g. "日本語", "!!!", "123").
 */
export function slug(name: string, max = AGENT_NAME_MAX): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z]+/, "");
  return trimDashes(s.slice(0, max));
}

/** `HERDR_PANE_ID` as a slug part: "wD:p1" -> "wd-p1". */
export function paneSuffix(paneId: string): string {
  return paneId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * `base` with "-<suffix>" appended, cut so the whole stays within AGENT_NAME_MAX. "" when the
 * base or the suffix is empty, or no room is left for the base.
 */
export function withSuffix(base: string, suffix: string): string {
  if (!base || !suffix) return "";
  const room = AGENT_NAME_MAX - suffix.length - 1;
  if (room < 1) return "";
  const head = trimDashes(base.slice(0, room));
  return head ? `${head}-${suffix}` : "";
}
