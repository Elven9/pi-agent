package sessionparser

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// TagsVersion is the pi-agent.tags payload version this package reads.
const TagsVersion = 1

// ScenarioVersion and ProjectVersion are the pi-agent.scenario and pi-agent.project payload
// versions this package reads.
const (
	ScenarioVersion = 1
	ProjectVersion  = 1
)

// Project source kinds ([ProjectSource.Kind]).
const (
	ProjectLocal  = "local"
	ProjectRemote = "remote"
)

// Metadata describes a session. Pointers and slices are nil when the file has no such entry.
type Metadata struct {
	SessionID string
	CWD       string
	StartedAt time.Time
	// LastActivityAt is the newest entry time of a user or assistant message anywhere in the
	// file (all branches); StartedAt when there is none. Other entries (tool results, model
	// changes, custom entries, ...) are not activity: pi and its extensions also write them when
	// a session is only opened or resumed.
	LastActivityAt time.Time
	// FormatVersion is pi's session format (header "version").
	FormatVersion int
	// ParentSession is the session file this one was forked from.
	ParentSession *string
	// Parent is the leader session that started this one as a subagent, from the last
	// pi-agent.parent entry in the file; nil for a session that is not a subagent's. Not to be
	// confused with ParentSession (a fork).
	Parent *ParentLink

	// AgentVersion is the pi-agent release of the last pi-agent.session-version entry in the
	// file; nil for files written by pi-agent 0.11.0 or older, or without pi-agent.
	AgentVersion *string
	// Tags is the last pi-agent.tags entry in the file (tags belong to the whole file).
	Tags *Tags
	// Name is the session name of the last session_info entry in the file; nil when unnamed.
	Name *string
	// Scenario is the scenario of the last pi-agent.scenario entry in the file; nil without
	// one, or when that entry records none.
	Scenario *string
	// Project is the project of the last pi-agent.project entry in the file; nil without one,
	// or when that entry records none.
	Project *Project

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

// Project is a pi-agent.project entry: the project (project.yaml) the session runs with.
type Project struct {
	Name   string
	Source ProjectSource
	At     time.Time
}

// ProjectSource is where a project's files come from.
type ProjectSource struct {
	// Kind is ProjectLocal or ProjectRemote.
	Kind string
	// Dir is a local project's absolute folder.
	Dir string
	// Provider ("github", "gitlab"), Repo, Path (folder in the repository, may be empty), Tag
	// and Commit (the tag's commit) are a remote project's.
	Provider, Repo, Path, Tag, Commit string
}

// ParentLink is a pi-agent.parent entry: the leader session that started this session as a
// subagent. The leader is on the same machine; its subagent-start entry for AgentID records
// this session's ID ([Subagent.ChildSessionID]).
type ParentLink struct {
	// SessionID is the leader's session ID (its header id).
	SessionID string
	// AgentID is this session's agent id in the leader, e.g. "a3".
	AgentID string
	At      time.Time
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

// Metadata reads the session's metadata. Version, tags, name and parent link are per file, as their
// extensions define them; the last activity counts the messages of every branch; models and
// errors come from the current branch. An invalid entry of these types is an [*EntryError].
func (s *Session) Metadata() (*Metadata, error) {
	m := &Metadata{
		SessionID:      s.Header.ID,
		CWD:            s.Header.CWD,
		StartedAt:      s.Header.Timestamp,
		LastActivityAt: s.Header.Timestamp,
		FormatVersion:  s.Header.FormatVersion(),
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
		case e.isCustom(CustomTypeScenario):
			err = m.readScenario(e)
		case e.isCustom(CustomTypeProject):
			err = m.readProject(e)
		case e.isCustom(CustomTypeParent):
			err = m.readParent(e)
		case e.Type == TypeMessage:
			err = m.readActivity(e)
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

func (m *Metadata) readScenario(e Entry) error {
	var d struct {
		Version *int    `json:"version"`
		Name    *string `json:"name"`
	}
	if err := e.decodeField("data", &d); err != nil {
		return err
	}
	if err := checkVersion(CustomTypeScenario, d.Version, ScenarioVersion); err != nil {
		return err
	}
	if d.Name != nil && *d.Name == "" {
		return missing("data.name")
	}
	m.Scenario = d.Name // null: the session runs without one from here on
	return nil
}

func (m *Metadata) readProject(e Entry) error {
	var d struct {
		Version *int    `json:"version"`
		Name    *string `json:"name"`
		Source  *struct {
			Kind     string `json:"kind"`
			Dir      string `json:"dir"`
			Provider string `json:"provider"`
			Repo     string `json:"repo"`
			Path     string `json:"path"`
			Tag      string `json:"tag"`
			Commit   string `json:"commit"`
		} `json:"source"`
	}
	if err := e.decodeField("data", &d); err != nil {
		return err
	}
	if err := checkVersion(CustomTypeProject, d.Version, ProjectVersion); err != nil {
		return err
	}
	if d.Name == nil {
		m.Project = nil // the session runs without one from here on
		return nil
	}
	if *d.Name == "" {
		return missing("data.name")
	}
	if d.Source == nil {
		return missing("data.source")
	}
	s := d.Source
	switch {
	case s.Kind == ProjectLocal && s.Dir == "":
		return missing("data.source.dir")
	case s.Kind == ProjectRemote && (s.Provider == "" || s.Repo == "" || s.Tag == "" || s.Commit == ""):
		return errors.New("remote data.source needs provider, repo, tag and commit")
	case s.Kind != ProjectLocal && s.Kind != ProjectRemote:
		return fmt.Errorf("data.source.kind %q is not local or remote", s.Kind)
	}
	m.Project = &Project{Name: *d.Name, At: e.Timestamp, Source: ProjectSource{
		Kind: s.Kind, Dir: s.Dir, Provider: s.Provider, Repo: s.Repo, Path: s.Path, Tag: s.Tag, Commit: s.Commit,
	}}
	return nil
}

func (m *Metadata) readParent(e Entry) error {
	var d struct {
		SessionID string `json:"sessionId"`
		AgentID   string `json:"agentId"`
	}
	if err := e.decodeField("data", &d); err != nil {
		return err
	}
	if d.SessionID == "" || d.AgentID == "" {
		return errors.New("missing data.sessionId or data.agentId")
	}
	m.Parent = &ParentLink{SessionID: d.SessionID, AgentID: d.AgentID, At: e.Timestamp}
	return nil
}

// readActivity moves LastActivityAt to a user or assistant message's entry time when it is
// newer. A message entry without a message payload is not activity.
func (m *Metadata) readActivity(e Entry) error {
	var d struct {
		Message *struct {
			Role string `json:"role"`
		} `json:"message"`
	}
	if err := json.Unmarshal(e.Raw, &d); err != nil {
		return err
	}
	if d.Message == nil || (d.Message.Role != "user" && d.Message.Role != "assistant") {
		return nil
	}
	if e.Timestamp.After(m.LastActivityAt) {
		m.LastActivityAt = e.Timestamp
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
