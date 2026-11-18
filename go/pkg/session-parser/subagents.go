package sessionparser

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"time"
)

// EnvelopeVersion is the subagent message envelope version ("v") this package reads.
const EnvelopeVersion = 1

// Subagent result statuses: the child's own, or set by the leader.
const (
	SubagentOK      = "ok"
	SubagentError   = "error"
	SubagentKilled  = "killed"
	SubagentFailed  = "failed"
	SubagentAborted = "aborted"
)

// Subagent is a subagent started on the current branch, with its result when there is one.
type Subagent struct {
	// ID is the agent id, e.g. "a3".
	ID string
	// Scenario is empty for a general subagent (started without a scenario).
	Scenario string
	// Kind is "task".
	Kind    string
	Task    string
	Project *string
	// RestartOf is the agent this one restarts, e.g. "a2".
	RestartOf *string
	// StartedBy is "model" or "user" (records from before it was recorded: "model").
	StartedBy     string
	StartedAt     time.Time
	TaskMessageID string
	// EntryID is the subagent-start entry.
	EntryID string
	// Result is nil when the branch has none (still running, or the session ended abruptly).
	Result *SubagentResult
}

// SubagentResult is a subagent's result: a subagent-result message, or else a subagent-end
// entry (recorded at session end, not yet delivered to the model).
type SubagentResult struct {
	ResultID string
	// Status is one of SubagentOK, SubagentError, SubagentKilled, SubagentFailed, SubagentAborted.
	Status  string
	Summary string
	// Reason says why for killed ("user", "leader") and aborted ("leader_exit", "reload", ...).
	Reason     *string
	DetailKind *string
	// Detail is the scenario's result detail; nil when there is none.
	Detail  json.RawMessage
	EndedAt time.Time
	// ChildSessionFile is the subagent's own session file (not parsed here).
	ChildSessionFile *string
	// Delivered is true for a subagent-result message (the model saw it), false for a
	// subagent-end entry.
	Delivered bool
	// EntryID is the entry the result comes from; MessageID its envelope id.
	EntryID   string
	MessageID string
}

var agentIDPattern = regexp.MustCompile(`^a([1-9]\d*)$`)

// Subagents returns the subagents started on the current branch in start order. A result
// message wins over an end record. A result whose start is on another branch is left out, as
// pi-agent does; one whose start is nowhere in the file, a duplicate start, or an invalid
// record is an [*EntryError].
func (s *Session) Subagents() ([]Subagent, error) {
	started := map[string]bool{}
	for _, e := range s.Entries {
		if e.isCustom(CustomTypeSubagentStart) {
			var d struct {
				ID int `json:"id"`
			}
			if err := e.decodeField("data", &d); err != nil {
				return nil, e.invalid(err)
			}
			started["a"+strconv.Itoa(d.ID)] = true
		}
	}
	var agents []Subagent
	index := map[string]int{}
	for _, e := range s.Branch() {
		var err error
		switch {
		case e.isCustom(CustomTypeSubagentStart):
			agents, err = addStart(agents, index, e)
		case e.isCustom(CustomTypeSubagentEnd):
			var d struct {
				Result json.RawMessage `json:"result"`
			}
			if err = e.decodeField("data", &d); err == nil {
				err = addResult(agents, index, started, e, d.Result, false)
			}
		case e.isCustomMessage(CustomTypeSubagentResult):
			var details json.RawMessage
			if err = e.decodeField("details", &details); err == nil {
				err = addResult(agents, index, started, e, details, true)
			}
		}
		if err != nil {
			return nil, e.invalid(err)
		}
	}
	return agents, nil
}

func addStart(agents []Subagent, index map[string]int, e Entry) ([]Subagent, error) {
	var d struct {
		ID            *int    `json:"id"`
		Scenario      string  `json:"scenario"`
		Kind          string  `json:"kind"`
		Task          *string `json:"task"`
		Project       *string `json:"project"`
		StartedAt     *int64  `json:"startedAt"`
		RestartOf     *int    `json:"restartOf"`
		StartedBy     *string `json:"startedBy"`
		TaskMessageID string  `json:"taskMessageId"`
	}
	if err := e.decodeField("data", &d); err != nil {
		return nil, err
	}
	switch {
	case d.ID == nil || *d.ID < 1:
		return nil, errors.New("data.id is not an agent number")
	case d.Task == nil || d.StartedAt == nil || d.TaskMessageID == "":
		return nil, errors.New("missing data.task, data.startedAt or data.taskMessageId")
	case d.Kind != "task":
		return nil, fmt.Errorf("data.kind %q is not task", d.Kind)
	case d.RestartOf != nil && *d.RestartOf < 1:
		return nil, errors.New("data.restartOf is not an agent number")
	}
	startedBy := "model"
	if d.StartedBy != nil {
		if *d.StartedBy != "model" && *d.StartedBy != "user" {
			return nil, fmt.Errorf("data.startedBy %q is not model or user", *d.StartedBy)
		}
		startedBy = *d.StartedBy
	}
	id := "a" + strconv.Itoa(*d.ID)
	if _, dup := index[id]; dup {
		return nil, fmt.Errorf("second start of %s", id)
	}
	a := Subagent{
		ID: id, Scenario: d.Scenario, Kind: d.Kind, Task: *d.Task, Project: d.Project,
		StartedBy: startedBy, StartedAt: time.UnixMilli(*d.StartedAt).UTC(), TaskMessageID: d.TaskMessageID, EntryID: e.ID,
	}
	if d.RestartOf != nil {
		a.RestartOf = new("a" + strconv.Itoa(*d.RestartOf))
	}
	index[id] = len(agents)
	return append(agents, a), nil
}

// addResult records a result (ResultDetails) unless the agent already has a delivered one.
func addResult(agents []Subagent, index map[string]int, started map[string]bool, e Entry, raw json.RawMessage, delivered bool) error {
	r, agentID, err := decodeResult(raw)
	if err != nil {
		return err
	}
	r.Delivered, r.EntryID = delivered, e.ID
	i, onBranch := index[agentID]
	switch {
	case !started[agentID]:
		return fmt.Errorf("result for %s, which was never started", agentID)
	case !onBranch:
		return nil
	case agents[i].Result != nil && (agents[i].Result.Delivered || !delivered):
		return nil
	}
	agents[i].Result = r
	return nil
}

func decodeResult(raw json.RawMessage) (*SubagentResult, string, error) {
	var d struct {
		AgentID          string  `json:"agentId"`
		ResultID         string  `json:"resultId"`
		EndedAt          *int64  `json:"endedAt"`
		ChildSessionFile *string `json:"childSessionFile"`
		Envelope         *struct {
			V    *int   `json:"v"`
			ID   string `json:"id"`
			Body *struct {
				Status     string          `json:"status"`
				Summary    *string         `json:"summary"`
				Reason     *string         `json:"reason"`
				DetailKind *string         `json:"detailKind"`
				Detail     json.RawMessage `json:"detail"`
			} `json:"body"`
		} `json:"envelope"`
	}
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, "", fmt.Errorf("result: %w", err)
	}
	switch {
	case !agentIDPattern.MatchString(d.AgentID):
		return nil, "", fmt.Errorf("result agentId %q is not an agent id", d.AgentID)
	case d.ResultID == "" || d.EndedAt == nil:
		return nil, "", errors.New("result is missing resultId or endedAt")
	case d.Envelope == nil:
		return nil, "", missing("result envelope")
	}
	if err := checkVersion("subagent envelope", d.Envelope.V, EnvelopeVersion); err != nil {
		return nil, "", err
	}
	body := d.Envelope.Body
	switch {
	case d.Envelope.ID == "" || body == nil || body.Summary == nil:
		return nil, "", errors.New("result envelope is missing id, body or body.summary")
	case !slices.Contains([]string{SubagentOK, SubagentError, SubagentKilled, SubagentFailed, SubagentAborted}, body.Status):
		return nil, "", fmt.Errorf("result status %q is unknown", body.Status)
	}
	return &SubagentResult{
		ResultID: d.ResultID, Status: body.Status, Summary: *body.Summary, Reason: body.Reason,
		DetailKind: body.DetailKind, Detail: nullToNil(body.Detail), EndedAt: time.UnixMilli(*d.EndedAt).UTC(),
		ChildSessionFile: d.ChildSessionFile, MessageID: d.Envelope.ID,
	}, d.AgentID, nil
}
