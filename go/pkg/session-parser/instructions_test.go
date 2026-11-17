package sessionparser

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func readInstructions(t *testing.T, s *Session) *ProjectInstructions {
	t.Helper()
	pi, err := s.ProjectInstructions()
	if err != nil {
		t.Fatal(err)
	}
	return pi
}

func TestProjectInstructionsListsWorkflowsAndDocsWithTheirReadsOnTheBranch(t *testing.T) {
	s, err := ParseFile("testdata/instructions.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	at := func(sec int) time.Time { return time.Date(2026, 11, 16, 6, 46, sec, 0, time.UTC) }
	// bug.md is read on the abandoned branch only.
	want := &ProjectInstructions{
		Workflows: []Instruction{
			{Path: "/w/project/workflows/add.md", When: "Adding a scenario.", Reads: []InstructionRead{
				{Tool: ToolRead, InCodemode: true, CallID: "cm/1", EntryID: "a2", At: at(40)},
			}},
			{Path: "/w/project/workflows/bug.md", When: "Extracting a bug report."},
		},
		Docs: []Instruction{
			{Path: "/w/project/docs/report.md", When: "Before changing report.json.", Reads: []InstructionRead{
				{Tool: ToolRead, CallID: "c1", EntryID: "a1", At: at(37)},
				{Tool: ToolRead, InCodemode: true, CallID: "cm/2", EntryID: "a2", At: at(40), Failed: true},
			}},
		},
	}
	if got := readInstructions(t, s); !reflect.DeepEqual(got, want) {
		t.Errorf("ProjectInstructions =\n%+v\nwant\n%+v", got, want)
	}
}

func TestProjectInstructionsMatchesProjectReadForARemoteProject(t *testing.T) {
	pi := readInstructions(t, parseLines(t,
		`{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","message":{"role":"system","content":"","sections":{"project_docs":"Read every doc with the project_read tool:\n- docs/a.md: Always."}}}`,
		`{"type":"message","id":"b","parentId":"a","timestamp":"2026-11-16T06:46:36Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"project_read","arguments":{"path":"./docs/a.md"}},{"type":"toolCall","id":"c2","name":"read","arguments":{"path":"docs/a.md"}}]}}`,
	))
	if len(pi.Docs) != 1 || len(pi.Docs[0].Reads) != 1 || pi.Docs[0].Reads[0].CallID != "c1" {
		t.Errorf("Docs = %+v, want docs/a.md read once by c1", pi.Docs)
	}
}

func TestProjectInstructionsContinuesAConditionOverSeveralLines(t *testing.T) {
	got := parseInstructions("<project_docs>\nintro\n- /a.md: first\nsecond\n- /b.md: other\n</project_docs>")
	want := []Instruction{{Path: "/a.md", When: "first\nsecond"}, {Path: "/b.md", When: "other"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("parseInstructions = %+v, want %+v", got, want)
	}
}

func TestProjectInstructionsWithoutAProjectIsEmpty(t *testing.T) {
	pi := readInstructions(t, parseLines(t,
		`{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","message":{"role":"system","content":"","sections":{"preamble":"hi"}}}`,
	))
	if pi.Workflows != nil || pi.Docs != nil {
		t.Errorf("ProjectInstructions = %+v, want empty", pi)
	}
}

func TestProjectInstructionsFailsOnAnInvalidSystemMessage(t *testing.T) {
	_, err := parseLines(t,
		`{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","message":{"role":"system","content":"","sections":[]}}`,
	).ProjectInstructions()
	var ee *EntryError
	if !errors.As(err, &ee) || ee.ID != "a" {
		t.Errorf("err = %v, want an EntryError for entry a", err)
	}
}
