package sessionparser

import (
	"errors"
	"strings"
	"testing"
)

func TestToolCallsReadsTheNestedCallsOfACodemodeScript(t *testing.T) {
	s, err := ParseFile("testdata/skills.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	calls, err := s.ToolCalls()
	if err != nil {
		t.Fatal(err)
	}
	cm := calls[len(calls)-1]
	if cm.Name != ToolCodemode || len(cm.Nested) != 3 {
		t.Fatalf("last call = %s with %d nested, want codemode with 3", cm.Name, len(cm.Nested))
	}
	read, bash, cancelled := cm.Nested[0], cm.Nested[1], cm.Nested[2]
	if read.ID != "cm/1" || read.Name != "read" || read.Status != NestedOK || string(read.Args) != read.ArgsPreview {
		t.Errorf("nested 1 = %+v", read)
	}
	if read.DurationMs == nil || *read.DurationMs != 4.5 || read.Error != nil {
		t.Errorf("nested 1 duration %v, error %v", read.DurationMs, read.Error)
	}
	if bash.Status != NestedError || bash.Error == nil || *bash.Error != "boom" {
		t.Errorf("nested 2 = %+v", bash)
	}
	if bash.Args != nil || !strings.HasSuffix(bash.ArgsPreview, "...") {
		t.Errorf("nested 2 args %s, preview %q; want no args from a cut preview", bash.Args, bash.ArgsPreview)
	}
	if cancelled.Status != NestedCancelled || cancelled.DurationMs != nil {
		t.Errorf("nested 3 = %+v", cancelled)
	}
}

func TestToolCallsHasNoNestedCallsOutsideCodemode(t *testing.T) {
	s := parseLines(t,
		`{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash","arguments":{}},{"type":"toolCall","id":"c2","name":"codemode","arguments":{}}]}}`,
		`{"type":"message","id":"b","parentId":"a","timestamp":"2026-11-16T06:46:36Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[],"isError":false,"details":{"calls":[{"id":"x","name":"y","args":"{}","status":"ok"}]}}}`,
		`{"type":"message","id":"c","parentId":"b","timestamp":"2026-11-16T06:46:36Z","message":{"role":"toolResult","toolCallId":"c2","toolName":"codemode","content":[],"isError":true}}`,
	)
	calls, err := s.ToolCalls()
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range calls {
		if c.Nested != nil {
			t.Errorf("%s has nested calls %+v, want nil", c.Name, c.Nested)
		}
	}
}

func TestToolCallsFailsOnInvalidNestedCalls(t *testing.T) {
	const call = `{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"codemode","arguments":{}}]}}`
	result := func(nested string) string {
		return `{"type":"message","id":"b","parentId":"a","timestamp":"2026-11-16T06:46:36Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"codemode","content":[],"isError":false,"details":{"calls":[` + nested + `]}}}`
	}
	for name, nested := range map[string]string{
		"no id":           `{"name":"read","args":"{}","status":"ok"}`,
		"no name":         `{"id":"c1/1","args":"{}","status":"ok"}`,
		"no args":         `{"id":"c1/1","name":"read","status":"ok"}`,
		"args not string": `{"id":"c1/1","name":"read","args":{},"status":"ok"}`,
		"unknown status":  `{"id":"c1/1","name":"read","args":"{}","status":"done"}`,
	} {
		t.Run(name, func(t *testing.T) {
			_, err := parseLines(t, call, result(nested)).ToolCalls()
			var ee *EntryError
			if !errors.As(err, &ee) || ee.ID != "b" {
				t.Errorf("err = %v, want an EntryError for entry b", err)
			}
		})
	}
}
