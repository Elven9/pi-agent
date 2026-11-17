package sessionparser

import (
	"encoding/json"
	"path/filepath"
	"regexp"
	"slices"
	"time"
)

// fileRead is a file a tool call read, directly or from a codemode script.
type fileRead struct {
	tool string
	path string
	// nested is true for a read a codemode script made.
	nested bool
	// callID is the read's call id (the nested call id in a script).
	callID string
	// entryID is the assistant message that made the call (the codemode call's).
	entryID string
	at      time.Time
	// failed: an error result or a cancelled nested call; a call without result is not failed.
	failed bool
}

// pathArg is a complete "path" string in cut codemode arguments.
var pathArg = regexp.MustCompile(`"path":("(?:[^"\\]|\\.)*")`)

// readsOf returns the reads c made with the given tools (a "path" argument), itself or from its
// codemode script, in order. A nested read whose path pi cut off is left out.
func readsOf(c ToolCall, tools ...string) []fileRead {
	var reads []fileRead
	if slices.Contains(tools, c.Name) {
		if p := pathOf(c.Args); p != "" {
			failed := c.Result != nil && c.Result.IsError
			reads = append(reads, fileRead{tool: c.Name, path: p, callID: c.ID, entryID: c.EntryID, at: c.CalledAt, failed: failed})
		}
	}
	if c.Codemode == nil {
		return reads
	}
	for _, n := range c.Codemode.Nested {
		if !slices.Contains(tools, n.Name) {
			continue
		}
		p := pathOf(n.Args)
		if n.Args == nil {
			p = cutPathOf(n.ArgsPreview)
		}
		if p == "" {
			continue
		}
		failed := n.Status == NestedError || n.Status == NestedCancelled
		reads = append(reads, fileRead{tool: n.Name, path: p, nested: true, callID: n.ID, entryID: c.EntryID, at: c.CalledAt, failed: failed})
	}
	return reads
}

// resolvePath makes path absolute against cwd (when it is relative and cwd is known) and clean.
func resolvePath(cwd, path string) string {
	if !filepath.IsAbs(path) && cwd != "" {
		path = filepath.Join(cwd, path)
	}
	return filepath.Clean(path)
}

// pathOf is the "path" argument of a read; empty when it has none.
func pathOf(args json.RawMessage) string {
	var a struct {
		Path string `json:"path"`
	}
	if json.Unmarshal(args, &a) != nil {
		return ""
	}
	return a.Path
}

// cutPathOf is the "path" argument in arguments pi cut short; empty when the cut hit the path.
func cutPathOf(preview string) string {
	m := pathArg.FindStringSubmatch(preview)
	if m == nil {
		return ""
	}
	var p string
	if json.Unmarshal([]byte(m[1]), &p) != nil {
		return ""
	}
	return p
}
