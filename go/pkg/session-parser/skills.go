package sessionparser

import (
	"encoding/json"
	"html"
	"path/filepath"
	"regexp"
	"time"
)

// TypeCompaction is a compaction entry; its systemMessage is a complete prompt checkpoint.
const TypeCompaction = "compaction"

// ToolRead is the name of pi's file read tool.
const ToolRead = "read"

// SkillFile is the file name of a skill's instructions.
const SkillFile = "SKILL.md"

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
	// EntryID is the user message (command) or the assistant message that made the call.
	EntryID string
	At      time.Time
	// Failed is true when the read returned an error or was cancelled. A read without a result
	// (pi stopped mid-call) is not failed.
	Failed bool
}

var (
	// skillItem is one skill in a skills prompt section (pi's <available_skills> and
	// pi-agent's <skills> use the same tags).
	skillItem = regexp.MustCompile(`(?s)<skill>\s*<name>(.*?)</name>\s*<description>(.*?)</description>\s*<location>(.*?)</location>\s*</skill>`)
	// skillBlock starts a user message expanded from /skill:name.
	skillBlock = regexp.MustCompile(`^<skill name="([^"]+)" location="([^"]+)">\n`)
	// pathArg is a complete "path" string in cut codemode arguments.
	pathArg = regexp.MustCompile(`"path":("(?:[^"\\]|\\.)*")`)
)

// Skills reads the skills of the current branch. The available ones replay the system prompt's
// "skills" section (system messages and compaction checkpoints). A load is a /skill:name
// command or a read of a SKILL.md, called directly or from a codemode script; a relative path
// is resolved against the session's cwd. A read of a SKILL.md the prompt never listed still
// counts. Reads through other tools (e.g. bash cat) are not seen. Invalid messages or codemode
// details fail as [Session.ToolCalls] does.
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
	for _, e := range s.Branch() {
		switch e.Type {
		case TypeCompaction:
			if err := r.readCheckpoint(e); err != nil {
				return nil, e.invalid(err)
			}
		case TypeMessage:
			msg, err := decodeMessage(e)
			if err == nil {
				switch msg.Role {
				case "system":
					err = r.readSystem(msg.Sections, false)
				case "user":
					err = r.readCommand(e, msg.Content)
				case "assistant":
					for _, c := range byEntry[e.ID] {
						r.readCall(c)
					}
				}
			}
			if err != nil {
				return nil, e.invalid(err)
			}
		}
	}
	return &Skills{Available: r.available, Used: r.uses}, nil
}

type skillReader struct {
	cwd       string
	available []Skill
	// listed are all skills the prompt listed on the branch, by location.
	listed map[string]Skill
	uses   []SkillUse
	used   map[string]int // index in uses, by location
}

func (r *skillReader) readCheckpoint(e Entry) error {
	var d struct {
		SystemMessage *struct {
			Sections json.RawMessage `json:"sections"`
		} `json:"systemMessage"`
	}
	if err := json.Unmarshal(e.Raw, &d); err != nil {
		return err
	}
	if d.SystemMessage == nil || d.SystemMessage.Sections == nil {
		return nil // older compaction entries have no checkpoint
	}
	return r.readSystem(d.SystemMessage.Sections, true)
}

// readSystem applies a system message's sections; complete is a checkpoint, where a missing
// section means none.
func (r *skillReader) readSystem(sections json.RawMessage, complete bool) error {
	if sections == nil {
		return nil
	}
	var m map[string]*string
	if err := json.Unmarshal(sections, &m); err != nil {
		return err
	}
	text, ok := m["skills"]
	if !ok && !complete {
		return nil
	}
	r.available = nil
	if text == nil {
		return nil
	}
	for _, it := range skillItem.FindAllStringSubmatch(*text, -1) {
		sk := Skill{Name: html.UnescapeString(it[1]), Description: html.UnescapeString(it[2]), Location: html.UnescapeString(it[3])}
		r.available = append(r.available, sk)
		r.listed[r.resolve(sk.Location)] = sk
	}
	return nil
}

func (r *skillReader) readCommand(e Entry, content json.RawMessage) error {
	text, err := firstText(content)
	if err != nil {
		return err
	}
	if m := skillBlock.FindStringSubmatch(text); m != nil {
		r.add(m[1], r.resolve(m[2]), SkillLoad{Via: SkillViaCommand, EntryID: e.ID, At: e.Timestamp})
	}
	return nil
}

func (r *skillReader) readCall(c ToolCall) {
	if c.Name == ToolRead {
		failed := c.Result != nil && c.Result.IsError
		r.readPath(pathOf(c.Args), SkillLoad{Via: SkillViaRead, CallID: c.ID, EntryID: c.EntryID, At: c.CalledAt, Failed: failed})
	}
	for _, n := range c.Nested {
		if n.Name != ToolRead {
			continue
		}
		path := pathOf(n.Args)
		if n.Args == nil {
			path = cutPathOf(n.ArgsPreview)
		}
		failed := n.Status == NestedError || n.Status == NestedCancelled
		r.readPath(path, SkillLoad{Via: SkillViaCodemode, CallID: n.ID, EntryID: c.EntryID, At: c.CalledAt, Failed: failed})
	}
}

func (r *skillReader) readPath(path string, load SkillLoad) {
	if path == "" {
		return
	}
	loc := r.resolve(path)
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

func (r *skillReader) resolve(path string) string {
	if !filepath.IsAbs(path) && r.cwd != "" {
		path = filepath.Join(r.cwd, path)
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
