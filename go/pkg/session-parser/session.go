package sessionparser

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"time"
)

// Entry types that the parser itself needs.
const (
	// TypeSession is the header's type.
	TypeSession = "session"
	// TypeCustom is an extension's custom entry (never model context).
	TypeCustom = "custom"
)

// CustomTypeSessionVersion is the custom entry with the pi-agent release that wrote the
// entries after it (src/shared/session-version.ts).
const CustomTypeSessionVersion = "pi-agent.session-version"

// SupportedFormatVersion is the pi session format this package reads ([Header.Version]).
const SupportedFormatVersion = 3

var (
	// ErrNoHeader is returned when the first line of a file is not a session header.
	ErrNoHeader = errors.New("no session header")
	// ErrUnsupportedFormat is returned for a header whose format is not [SupportedFormatVersion].
	ErrUnsupportedFormat = errors.New("unsupported session format")
)

// LineError is a line that is not valid JSON or not a valid entry.
type LineError struct {
	Line int // 1-based
	Err  error
}

func (e *LineError) Error() string { return fmt.Sprintf("line %d: %v", e.Line, e.Err) }

func (e *LineError) Unwrap() error { return e.Err }

// Header is the first line of a session file. It is not part of the entry tree.
type Header struct {
	Type string `json:"type"`
	// Version is pi's session format version; 0 when the file has none (format 1).
	Version   int       `json:"version,omitempty"`
	ID        string    `json:"id"`
	Timestamp time.Time `json:"timestamp"`
	CWD       string    `json:"cwd"`
	// ParentSession is the session file this one was forked from, if any.
	ParentSession string `json:"parentSession,omitempty"`
}

// FormatVersion is pi's session format version, 1 when the header has none.
func (h Header) FormatVersion() int {
	if h.Version == 0 {
		return 1
	}
	return h.Version
}

// Entry is one line after the header: its envelope, and the whole line in Raw.
type Entry struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	// ParentID is the previous entry on its branch; empty for a root entry.
	ParentID  string    `json:"parentId"`
	Timestamp time.Time `json:"timestamp"`
	// CustomType names the extension's entry for "custom" and "custom_message" entries.
	CustomType string `json:"customType,omitempty"`
	// Raw is the entry's whole JSON line.
	Raw json.RawMessage `json:"-"`
}

// Session is a parsed session file: the header and its entries in file order.
type Session struct {
	Header  Header
	Entries []Entry
}

// Branch is the current branch: from the root to the leaf, the last entry in the file (where
// pi continues when it loads the file). Entries on other branches are left out. Empty when the
// file has no entries.
func (s *Session) Branch() []Entry {
	if len(s.Entries) == 0 {
		return nil
	}
	index := make(map[string]int, len(s.Entries))
	for i, e := range s.Entries {
		index[e.ID] = i
	}
	var branch []Entry
	// Parse checked that every parent is an earlier entry, so this ends at a root.
	for i := len(s.Entries) - 1; ; {
		branch = append(branch, s.Entries[i])
		parent := s.Entries[i].ParentID
		if parent == "" {
			break
		}
		i = index[parent]
	}
	slices.Reverse(branch)
	return branch
}

// ParseFile parses the session file at path.
func ParseFile(path string) (*Session, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open session: %w", err)
	}
	defer func() { _ = f.Close() }() // read-only: nothing to lose on close
	s, err := Parse(f)
	if err != nil {
		return nil, fmt.Errorf("parse session %s: %w", path, err)
	}
	return s, nil
}

// Parse reads a session file. Blank lines are skipped. The first line must be a session
// header ([ErrNoHeader]) of format [SupportedFormatVersion] ([ErrUnsupportedFormat]). Every
// other line must be an entry with a type, a unique id and a parentId naming an earlier entry
// (or null); a line that is not is a [*LineError].
func Parse(r io.Reader) (*Session, error) {
	br := bufio.NewReader(r)
	var s *Session
	seen := map[string]bool{}
	for n := 1; ; n++ {
		line, readErr := br.ReadBytes('\n')
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return nil, fmt.Errorf("read line %d: %w", n, readErr)
		}
		if line = bytes.TrimSpace(line); len(line) > 0 {
			if s == nil {
				h, err := parseHeader(line)
				if err != nil {
					return nil, &LineError{Line: n, Err: err}
				}
				s = &Session{Header: h}
			} else {
				e, err := parseEntry(line)
				if err == nil {
					err = checkLinks(e, seen)
				}
				if err != nil {
					return nil, &LineError{Line: n, Err: err}
				}
				seen[e.ID] = true
				s.Entries = append(s.Entries, e)
			}
		}
		if readErr != nil { // io.EOF
			break
		}
	}
	if s == nil {
		return nil, ErrNoHeader
	}
	return s, nil
}

func parseHeader(line []byte) (Header, error) {
	var h Header
	if err := json.Unmarshal(line, &h); err != nil {
		return Header{}, fmt.Errorf("%w: %w", ErrNoHeader, err)
	}
	if h.Type != TypeSession || h.ID == "" {
		return Header{}, ErrNoHeader
	}
	if v := h.FormatVersion(); v != SupportedFormatVersion {
		return Header{}, fmt.Errorf("%w: version %d, want %d", ErrUnsupportedFormat, v, SupportedFormatVersion)
	}
	return h, nil
}

// checkLinks checks that e's id is new and its parent is an earlier entry.
func checkLinks(e Entry, seen map[string]bool) error {
	switch {
	case e.ID == "":
		return errors.New("entry has no id")
	case seen[e.ID]:
		return fmt.Errorf("duplicate entry id %q", e.ID)
	case e.ParentID != "" && !seen[e.ParentID]:
		return fmt.Errorf("entry %q: parent %q is not an earlier entry", e.ID, e.ParentID)
	}
	return nil
}

func parseEntry(line []byte) (Entry, error) {
	var e Entry
	if err := json.Unmarshal(line, &e); err != nil {
		return Entry{}, err
	}
	if e.Type == "" {
		return Entry{}, errors.New("entry has no type")
	}
	e.Raw = bytes.Clone(line)
	return e, nil
}
