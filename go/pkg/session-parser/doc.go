// Package sessionparser reads pi session files (JSONL) written by pi with the pi-agent
// extensions.
//
// A session file has one JSON object per line. The first line is the [Header]; every other
// line is an entry that pi links into a tree by id and parentId. Two versions describe a file:
//
//   - [Header.Version] is pi's session format. pi owns it and migrates older files when it
//     loads them; pi-agent never changes it.
//   - [Session.AgentVersion] is the pi-agent release that wrote the file, from its
//     "pi-agent.session-version" custom entries.
//
// The parser reads every entry's envelope (type, id, parentId, timestamp, customType) and
// keeps the whole line in [Entry.Raw], so entry types it doesn't know are kept as they are.
package sessionparser
