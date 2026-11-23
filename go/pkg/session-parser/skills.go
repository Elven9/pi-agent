package sessionparser

import (
	"encoding/json"
	"fmt"
	"html"
	"path/filepath"
	"regexp"
	"time"
)

// ToolRead is the name of pi's file read tool.
const ToolRead = "read"

// SkillFile is the file name of a skill's instructions.
const SkillFile = "SKILL.md"

// SkillLoadVersion is the pi-agent.skill-load payload version this package reads.
const SkillLoadVersion = 1

// How a skill was loaded ([SkillLoad.Via]).
const (
	// SkillViaCommand: the user typed /skill:name and pi put the skill into the user message.
	SkillViaCommand = "command"
	// SkillViaRead: the model read the skill file with the read tool.
	SkillViaRead = "read"
	// SkillViaCodemode: a codemode script read the skill file with the read tool.
	SkillViaCodemode = "codemode"
)

// Skills are the skills a session offered and the ones it loaded.
type Skills struct {
	// Available are the skills the system prompt lists at the end of the current branch; nil
	// when it lists none.
	Available []Skill
	// Used are the skills loaded on the current branch, in the order of their first load.
	Used []SkillUse
	// Recorded is true when Used comes from the branch's pi-agent.skill-load entries, false
	// when it is read from the transcript (files written without the skill-loads extension).
	Recorded bool
}

// Skill is a skill the system prompt lists.
type Skill struct {
	Name        string
	Description string
	// Location is the path of its SKILL.md.
	Location string
}

// SkillUse is a skill loaded at least once.
type SkillUse struct {
	// Name is the listed skill's name; for a SKILL.md the prompt never listed, the name of its
	// folder.
	Name string
	// Location is the path of its SKILL.md, absolute when the session's cwd made it so.
	Location string
	// Loads are each time it was loaded, in order.
	Loads []SkillLoad
}

// SkillLoad is one load of a skill.
type SkillLoad struct {
	// Via is SkillViaCommand, SkillViaRead or SkillViaCodemode.
	Via string
	// CallID is the read's tool call id (the nested call id for codemode); empty for a command.
	CallID string
	// EntryID is the user message (command) or the assistant message that made the call; for a
	// recorded load ([Skills.Recorded]), the pi-agent.skill-load entry.
	EntryID string
	At      time.Time
	// Failed is true when the read returned an error or was cancelled. A read without a result
	// (pi stopped mid-call) is not failed. Recorded loads are never failed: the extension records
	// successful reads only.
	Failed bool
}

var (
	// skillItem is one skill in a skills prompt section (pi's <available_skills> and
	// pi-agent's <skills> use the same tags).
	skillItem = regexp.MustCompile(`(?s)<skill>\s*<name>(.*?)</name>\s*<description>(.*?)</description>\s*<location>(.*?)</location>\s*</skill>`)
	// skillBlock starts a user message expanded from /skill:name.
	skillBlock = regexp.MustCompile(`^<skill name="([^"]+)" location="([^"]+)">\n`)
)

// Skills reads the skills of the current branch. The available ones replay the system prompt's
// "skills" section (system messages and compaction checkpoints).
//
// The loads come from the branch's pi-agent.skill-load entries when it has any ([Skills.Recorded]):
// one per load, as the skill-loads extension saw it (a successful read of a loaded skill's
// SKILL.md, directly or from a codemode script, or /skill:name). An invalid entry is an
// [*EntryError], another payload version an [*UnsupportedVersionError].
//
// Without such entries they are read from the transcript: a /skill:name command or a read of a
// SKILL.md, called directly or from a codemode script; a relative path is resolved against the
// session's cwd. A read of a SKILL.md the prompt never listed still counts. Reads through other
// tools (e.g. bash cat) are not seen. Invalid messages or codemode details fail as
// [Session.ToolCalls] does.
func (s *Session) Skills() (*Skills, error) {
	calls, err := s.ToolCalls()
	if err != nil {
		return nil, err
	}
	byEntry := map[string][]ToolCall{}
	for _, c := range calls {
		byEntry[c.EntryID] = append(byEntry[c.EntryID], c)
	}
	r := skillReader{cwd: s.Header.CWD, listed: map[string]Skill{}, used: map[string]int{}}
	prompt := promptSections{}
	recorded := skillReader{used: map[string]int{}}
	for _, e := range s.Branch() {
		system, err := prompt.apply(e)
		switch {
		case err != nil:
		case e.isCustom(CustomTypeSkillLoad):
			err = recorded.readEntry(e)
		case system:
			r.readSection(prompt["skills"])
		case e.Type == TypeMessage:
			var msg message
			if msg, err = decodeMessage(e); err == nil && msg.Role == "user" {
				err = r.readCommand(e, msg.Content)
			}
			for _, c := range byEntry[e.ID] {
				for _, rd := range readsOf(c, ToolRead) {
					r.readFile(rd)
				}
			}
		}
		if err != nil {
			return nil, e.invalid(err)
		}
	}
	if recorded.uses != nil {
		return &Skills{Available: r.available, Used: recorded.uses, Recorded: true}, nil
	}
	return &Skills{Available: r.available, Used: r.uses}, nil
}

// skillLoadEntry is a pi-agent.skill-load payload (src/shared/skill-loads.ts).
type skillLoadEntry struct {
	Version    *int   `json:"version"`
	Name       string `json:"name"`
	Location   string `json:"location"`
	Via        string `json:"via"`
	ToolCallID string `json:"toolCallId"`
}

// readEntry adds a recorded load.
func (r *skillReader) readEntry(e Entry) error {
	var d skillLoadEntry
	if err := e.decodeField("data", &d); err != nil {
		return err
	}
	if err := checkVersion(CustomTypeSkillLoad, d.Version, SkillLoadVersion); err != nil {
		return err
	}
	switch {
	case d.Name == "":
		return missing("name")
	case d.Location == "":
		return missing("location")
	}
	switch d.Via {
	case SkillViaCommand, SkillViaRead, SkillViaCodemode:
	default:
		return fmt.Errorf("via %q is not command, read or codemode", d.Via)
	}
	r.add(d.Name, filepath.Clean(d.Location), SkillLoad{Via: d.Via, CallID: d.ToolCallID, EntryID: e.ID, At: e.Timestamp})
	return nil
}

type skillReader struct {
	cwd       string
	available []Skill
	// listed are all skills the prompt listed on the branch, by location.
	listed map[string]Skill
	uses   []SkillUse
	used   map[string]int // index in uses, by location
}

// readSection reads the current skills section; empty when there is none.
func (r *skillReader) readSection(text string) {
	r.available = nil
	for _, it := range skillItem.FindAllStringSubmatch(text, -1) {
		sk := Skill{Name: html.UnescapeString(it[1]), Description: html.UnescapeString(it[2]), Location: html.UnescapeString(it[3])}
		r.available = append(r.available, sk)
		r.listed[resolvePath(r.cwd, sk.Location)] = sk
	}
}

func (r *skillReader) readCommand(e Entry, content json.RawMessage) error {
	text, err := firstText(content)
	if err != nil {
		return err
	}
	if m := skillBlock.FindStringSubmatch(text); m != nil {
		r.add(m[1], resolvePath(r.cwd, m[2]), SkillLoad{Via: SkillViaCommand, EntryID: e.ID, At: e.Timestamp})
	}
	return nil
}

func (r *skillReader) readFile(rd fileRead) {
	via := SkillViaRead
	if rd.nested {
		via = SkillViaCodemode
	}
	load := SkillLoad{Via: via, CallID: rd.callID, EntryID: rd.entryID, At: rd.at, Failed: rd.failed}
	loc := resolvePath(r.cwd, rd.path)
	if sk, ok := r.listed[loc]; ok {
		r.add(sk.Name, loc, load)
	} else if filepath.Base(loc) == SkillFile {
		r.add(filepath.Base(filepath.Dir(loc)), loc, load)
	}
}

func (r *skillReader) add(name, loc string, load SkillLoad) {
	i, ok := r.used[loc]
	if !ok {
		i = len(r.uses)
		r.used[loc] = i
		r.uses = append(r.uses, SkillUse{Name: name, Location: loc})
	}
	r.uses[i].Loads = append(r.uses[i].Loads, load)
}

// firstText is the first text of a message's content: a string, or the first text block.
func firstText(content json.RawMessage) (string, error) {
	if nullToNil(content) == nil {
		return "", nil
	}
	var s string
	if json.Unmarshal(content, &s) == nil {
		return s, nil
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(content, &blocks); err != nil {
		return "", err
	}
	for _, b := range blocks {
		if b.Type == "text" {
			return b.Text, nil
		}
	}
	return "", nil
}
