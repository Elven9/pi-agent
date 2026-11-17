package sessionparser

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// TagsVersion is the pi-agent.tags payload version this package reads.
const TagsVersion = 1

// Metadata describes a session. Pointers and slices are nil when the file has no such entry.
type Metadata struct {
	SessionID string
	CWD       string
	StartedAt time.Time
	// FormatVersion is pi's session format (header "version").
	FormatVersion int
	// ParentSession is the session file this one was forked from.
	ParentSession *string

	// AgentVersion is the pi-agent release of the last pi-agent.session-version entry in the
	// file; nil for files written by pi-agent 0.11.0 or older, or without pi-agent.
	AgentVersion *string
	// Tags is the last pi-agent.tags entry in the file (tags belong to the whole file).
	Tags *Tags
	// Name is the session name of the last session_info entry in the file; nil when unnamed.
	Name *string

	// Models are the model changes on the current branch, in order.
	Models []ModelChange
	// Errors are the pi-agent.error entries on the current branch, in order.
	Errors []AgentError
}

// Tags is a pi-agent.tags entry: the session's whole tag list.
type Tags struct {
	// Tags in the order given; empty when cleared.
	Tags []string
	// Source is what set them: "flag" (--tags or task.json), "command" (/tags) or "default" (the
	// last segment of the cwd, for a session never tagged).
	Source string
	At     time.Time
}

// ModelChange is a model_change entry.
type ModelChange struct {
	Provider string
	ModelID  string
	At       time.Time
}

// AgentError is a pi-agent.error entry: an extension could not run.
type AgentError struct {
	Message string
	At      time.Time
}

// Metadata reads the session's metadata. Version, tags and name are per file, as their
// extensions define them; models and errors come from the current branch. An invalid entry
// of these types is an [*EntryError].
func (s *Session) Metadata() (*Metadata, error) {
	m := &Metadata{
		SessionID:     s.Header.ID,
		CWD:           s.Header.CWD,
		StartedAt:     s.Header.Timestamp,
		FormatVersion: s.Header.FormatVersion(),
	}
	if s.Header.ParentSession != "" {
		m.ParentSession = new(s.Header.ParentSession)
	}
	for _, e := range s.Entries {
		var err error
		switch {
		case e.isCustom(CustomTypeSessionVersion):
			err = m.readAgentVersion(e)
		case e.isCustom(CustomTypeTags):
			err = m.readTags(e)
		case e.Type == TypeSessionInfo:
			err = m.readName(e)
		}
		if err != nil {
			return nil, e.invalid(err)
		}
	}
	for _, e := range s.Branch() {
		var err error
		switch {
		case e.Type == TypeModelChange:
			err = m.readModel(e)
		case e.isCustom(CustomTypeError):
			err = m.readError(e)
		}
		if err != nil {
			return nil, e.invalid(err)
		}
	}
	return m, nil
}

func (m *Metadata) readAgentVersion(e Entry) error {
	var d struct {
		Version *string `json:"version"`
	}
	if err := e.decodeField("data", &d); err != nil {
		return err
	}
	if d.Version == nil || *d.Version == "" {
		return missing("data.version")
	}
	m.AgentVersion = d.Version
	return nil
}

func (m *Metadata) readTags(e Entry) error {
	var d struct {
		Version *int     `json:"version"`
		Tags    []string `json:"tags"`
		Source  string   `json:"source"`
	}
	if err := e.decodeField("data", &d); err != nil {
		return err
	}
	if err := checkVersion(CustomTypeTags, d.Version, TagsVersion); err != nil {
		return err
	}
	if d.Tags == nil {
		return missing("data.tags")
	}
	switch d.Source {
	case "flag", "command", "default":
	default:
		return fmt.Errorf("data.source %q is not flag, command or default", d.Source)
	}
	m.Tags = &Tags{Tags: d.Tags, Source: d.Source, At: e.Timestamp}
	return nil
}

func (m *Metadata) readName(e Entry) error {
	var d struct {
		Name *string `json:"name"`
	}
	if err := json.Unmarshal(e.Raw, &d); err != nil {
		return err
	}
	m.Name = nil
	if d.Name != nil && *d.Name != "" {
		m.Name = d.Name
	}
	return nil
}

func (m *Metadata) readModel(e Entry) error {
	var d struct {
		Provider string `json:"provider"`
		ModelID  string `json:"modelId"`
	}
	if err := json.Unmarshal(e.Raw, &d); err != nil {
		return err
	}
	if d.Provider == "" || d.ModelID == "" {
		return errors.New("missing provider or modelId")
	}
	m.Models = append(m.Models, ModelChange{Provider: d.Provider, ModelID: d.ModelID, At: e.Timestamp})
	return nil
}

func (m *Metadata) readError(e Entry) error {
	var d struct {
		Message *string `json:"message"`
	}
	if err := e.decodeField("data", &d); err != nil {
		return err
	}
	if d.Message == nil {
		return missing("data.message")
	}
	m.Errors = append(m.Errors, AgentError{Message: *d.Message, At: e.Timestamp})
	return nil
}
