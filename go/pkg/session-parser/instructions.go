package sessionparser

import (
	"path"
	"strings"
	"time"
)

// ToolProjectRead is pi-agent's tool that reads a remote project's files.
const ToolProjectRead = "project_read"

// pi-agent's project prompt sections that list files to read.
const (
	SectionProjectWorkflows = "project_workflows"
	SectionProjectDocs      = "project_docs"
)

// ProjectInstructions are the project's workflows and docs the system prompt lists at the end
// of the current branch, each with the reads of its file. Nil lists when the prompt has none
// (no project, or a project without them).
type ProjectInstructions struct {
	// Workflows are step-by-step task instructions, in the prompt's order.
	Workflows []Instruction
	// Docs are documents to read when their condition applies, in the prompt's order.
	Docs []Instruction
}

// Instruction is a workflow or doc the prompt lists.
type Instruction struct {
	// Path is as listed: absolute for a local project (read with the read tool), relative to
	// the project for a remote one (read with project_read).
	Path string
	// When is the condition under which the agent must read it.
	When string
	// Reads are the reads of its file on the current branch, in order; nil when never read.
	Reads []InstructionRead
}

// InstructionRead is one read of an instruction's file.
type InstructionRead struct {
	// Tool is ToolRead or ToolProjectRead.
	Tool string
	// InCodemode is true for a read a codemode script made.
	InCodemode bool
	// CallID is the read's call id (the nested call id in a script).
	CallID string
	// EntryID is the assistant message that made the call.
	EntryID string
	At      time.Time
	// Failed is true for an error result or a cancelled nested call.
	Failed bool
}

// ProjectInstructions reads the project's workflows and docs and whether the agent read them.
// The lists replay the system prompt along the current branch. A read matches an instruction
// by path: the read tool's path resolved against the session's cwd for a listed absolute
// path, project_read's path for a listed relative one. A read anywhere on the branch counts,
// also one from a codemode script; reads through other tools (e.g. bash cat) are not seen.
// Invalid messages or codemode details fail as [Session.ToolCalls] does.
func (s *Session) ProjectInstructions() (*ProjectInstructions, error) {
	calls, err := s.ToolCalls()
	if err != nil {
		return nil, err
	}
	prompt := promptSections{}
	for _, e := range s.Branch() {
		if _, err := prompt.apply(e); err != nil {
			return nil, e.invalid(err)
		}
	}
	pi := &ProjectInstructions{
		Workflows: parseInstructions(prompt[SectionProjectWorkflows]),
		Docs:      parseInstructions(prompt[SectionProjectDocs]),
	}
	byKey := map[string][]*Instruction{}
	for _, list := range [][]Instruction{pi.Workflows, pi.Docs} {
		for i := range list {
			k := s.instructionKey(list[i].Path)
			byKey[k] = append(byKey[k], &list[i])
		}
	}
	for _, c := range calls {
		for _, rd := range readsOf(c, ToolRead, ToolProjectRead) {
			read := InstructionRead{Tool: rd.tool, InCodemode: rd.nested, CallID: rd.callID, EntryID: rd.entryID, At: rd.at, Failed: rd.failed}
			for _, in := range byKey[s.readKey(rd)] {
				in.Reads = append(in.Reads, read)
			}
		}
	}
	return pi, nil
}

// instructionKey identifies a listed path: a file for read, or one for project_read.
func (s *Session) instructionKey(p string) string {
	if path.IsAbs(p) {
		return ToolRead + ":" + resolvePath(s.Header.CWD, p)
	}
	return ToolProjectRead + ":" + path.Clean(p)
}

func (s *Session) readKey(rd fileRead) string {
	if rd.tool == ToolProjectRead {
		return ToolProjectRead + ":" + path.Clean(rd.path)
	}
	return ToolRead + ":" + resolvePath(s.Header.CWD, rd.path)
}

// parseInstructions reads the "- <path>: <when>" items of a project section. Other lines
// before the first item (the introduction, the opening tag) are left out; lines after an item
// continue its condition.
func parseInstructions(section string) []Instruction {
	var list []Instruction
	for line := range strings.Lines(section) {
		line = strings.TrimRight(line, "\r\n")
		if item, ok := strings.CutPrefix(line, "- "); ok {
			if p, when, ok := strings.Cut(item, ": "); ok {
				list = append(list, Instruction{Path: p, When: when})
				continue
			}
		}
		if len(list) == 0 || (strings.HasPrefix(line, "</") && strings.HasSuffix(line, ">")) {
			continue
		}
		last := &list[len(list)-1]
		last.When += "\n" + line
	}
	return list
}
