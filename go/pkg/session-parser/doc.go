// Package sessionparser reads pi session files (JSONL) written by pi with the pi-agent
// extensions.
//
// A session file has one JSON object per line. The first line is the [Header]; every other
// line is an entry that pi links into a tree by id and parentId. [Session.Branch] is the
// current branch: from the root to the last entry in the file. Two versions describe a file:
//
//   - [Header.Version] is pi's session format. pi owns it and migrates older files when it
//     loads them; this package reads format [SupportedFormatVersion] only.
//   - [Metadata.AgentVersion] is the pi-agent release that wrote the file, from its
//     "pi-agent.session-version" custom entries.
//
// [Parse] reads every entry's envelope and keeps the whole line in [Entry.Raw]. The data is
// read in groups, each on its own:
//
//   - [Session.Metadata]: header fields, last activity, pi-agent version, tags, name, scenario,
//     project, the leader of a subagent's session ([Metadata.Parent]), models, errors.
//   - [Session.ToolCalls]: tool calls with their results and tool-ref handles; codemode calls
//     with their script, its intent and the calls it made ([ToolCall.Codemode]).
//   - [Session.Metrics]: the pi-agent.metrics totals and samples.
//   - [Session.Subagents]: subagents started, their session IDs and their results.
//   - [Session.Skills]: skills the prompt offers and the ones loaded (/skill:name, or a read of
//     SKILL.md, also from codemode): from "pi-agent.skill-load" custom entries when the branch
//     has them, else from the transcript.
//   - [Session.ProjectInstructions]: the project's workflows and docs, and their reads.
//
// Values a file doesn't have are nil. Parsing is strict: an invalid line fails [Parse] with a
// [*LineError], and an invalid entry fails its group with an [*EntryError] (or an
// [*UnsupportedVersionError] for a pi-agent payload version this package doesn't know).
package sessionparser
