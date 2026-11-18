import type { AutocompleteItem } from "@earendil-works/pi-tui";

/** A titled block of tags in `/tags` completion (the cwd tag, a preset group, tags used before). */
export interface Section {
  name: string;
  tags: string[];
}

/** Section names wider than this are cut with an ellipsis, so the tags stay aligned. */
export const MAX_SECTION_WIDTH = 12;

/**
 * `/tags` completion items as a small tree: the section name on its first row, then branches.
 *
 *   cwd    └ pi-agent
 *   work   ├ bug
 *          └ feature
 *   used   └ release
 *
 * Every row is one tag (no header rows: the menu can only show selectable items). Sections are
 * for display only: `fits` filters tags of every section alike; a tag is shown once, in its first
 * section; sections left empty are dropped. Values are `head` (the tags typed before the last
 * comma) plus the tag.
 */
export function treeItems(sections: Section[], head: string, fits: (tag: string) => boolean): AutocompleteItem[] {
  const seen = new Set<string>();
  const shown: Section[] = [];
  for (const s of sections) {
    const tags = s.tags.filter((t) => fits(t) && !seen.has(t));
    for (const t of tags) seen.add(t);
    if (tags.length) shown.push({ name: cut(s.name), tags });
  }
  const width = Math.max(0, ...shown.map((s) => [...s.name].length));
  return shown.flatMap((s) =>
    s.tags.map((tag, i) => {
      const name = i === 0 ? s.name : "";
      const branch = i === s.tags.length - 1 ? "└" : "├";
      return { value: head + tag, label: `${name}${" ".repeat(width - [...name].length)} ${branch} ${tag}` };
    }),
  );
}

const cut = (name: string) => ([...name].length > MAX_SECTION_WIDTH ? [...name].slice(0, MAX_SECTION_WIDTH - 1).join("") + "…" : name);
