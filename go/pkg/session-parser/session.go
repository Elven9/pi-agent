package sessionparser

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
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

// ErrNoHeader is returned when the first line of a file is not a session header.
var ErrNoHeader = errors.New("no session header")

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

// AgentVersion is the pi-agent release in the file's last valid session-version entry, or ""
// when it has none (written by pi-agent 0.11.0 or older, or without pi-agent).
func (s *Session) AgentVersion() string {
	for i := len(s.Entries) - 1; i >= 0; i-- {
		e := s.Entries[i]
		if e.Type != TypeCustom || e.CustomType != CustomTypeSessionVersion {
			continue
		}
		var v struct {
			Data struct {
				Version string `json:"version"`
			} `json:"data"`
		}
		if json.Unmarshal(e.Raw, &v) == nil && v.Data.Version != "" {
			return v.Data.Version
		}
	}
	return ""
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
// header ([ErrNoHeader]); a line that is not valid JSON or has no type is a [*LineError].
func Parse(r io.Reader) (*Session, error) {
	br := bufio.NewReader(r)
	var s *Session
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
				if err != nil {
					return nil, &LineError{Line: n, Err: err}
				}
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
	return h, nil
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
