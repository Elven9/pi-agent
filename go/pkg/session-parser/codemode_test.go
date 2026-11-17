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
	if cm.Name != ToolCodemode || cm.Codemode == nil || len(cm.Codemode.Nested) != 3 {
		t.Fatalf("last call = %+v, want codemode with 3 nested calls", cm)
	}
	nested := cm.Codemode.Nested
	read, bash, cancelled := nested[0], nested[1], nested[2]
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

func TestToolCallsReadsACodemodeScriptItsIntentAndFullOutput(t *testing.T) {
	s, err := ParseFile("testdata/skills.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	calls, err := s.ToolCalls()
	if err != nil {
		t.Fatal(err)
	}
	sc := calls[len(calls)-1].Codemode
	if sc == nil || !strings.HasPrefix(sc.Code, "// @options:") || !strings.Contains(sc.Code, "tools.read") {
		t.Fatalf("Codemode = %+v", sc)
	}
	if sc.Intent == nil || *sc.Intent != "load the go skill" {
		t.Errorf("Intent = %v, want load the go skill", sc.Intent)
	}
	if sc.FullOutputPath == nil || *sc.FullOutputPath != "/tmp/out.txt" {
		t.Errorf("FullOutputPath = %v", sc.FullOutputPath)
	}
}

func TestIntentIsTheIntentCommentAmongTheLeadingComments(t *testing.T) {
	for code, want := range map[string]string{
		"// intent: list files\nawait x();":                       "list files",
		"\n  //intent:   spaced out  \n":                          "spaced out",
		"// @options: {}\n// other\n// intent: third\nawait x();": "third",
		"await x();\n// intent: too late":                         "",
		"// intent:   \nawait x();":                               "",
		"/* intent: block */":                                     "",
		"":                                                        "",
	} {
		got := intentOf(code)
		if (want == "") != (got == nil) || (got != nil && *got != want) {
			t.Errorf("intentOf(%q) = %v, want %q", code, got, want)
		}
	}
}

func TestToolCallsKeepsACodemodeCallWithoutResultOrCode(t *testing.T) {
	calls, err := parseLines(t,
		`{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"codemode","arguments":{},"argumentsError":"bad"}]}}`,
	).ToolCalls()
	if err != nil {
		t.Fatal(err)
	}
	sc := calls[0].Codemode
	if sc == nil || sc.Code != "" || sc.Intent != nil || sc.Nested != nil || sc.FullOutputPath != nil {
		t.Errorf("Codemode = %+v, want an empty script", sc)
	}
}

func TestToolCallsHasNoCodemodeScriptOutsideCodemode(t *testing.T) {
	s := parseLines(t,
		`{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash","arguments":{}},{"type":"toolCall","id":"c2","name":"codemode","arguments":{}}]}}`,
		`{"type":"message","id":"b","parentId":"a","timestamp":"2026-11-16T06:46:36Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[],"isError":false,"details":{"calls":[{"id":"x","name":"y","args":"{}","status":"ok"}]}}}`,
		`{"type":"message","id":"c","parentId":"b","timestamp":"2026-11-16T06:46:36Z","message":{"role":"toolResult","toolCallId":"c2","toolName":"codemode","content":[],"isError":true}}`,
	)
	calls, err := s.ToolCalls()
	if err != nil {
		t.Fatal(err)
	}
	if bash := calls[0]; bash.Codemode != nil {
		t.Errorf("bash has a codemode script %+v, want nil", bash.Codemode)
	}
	if cm := calls[1]; cm.Codemode == nil || cm.Codemode.Nested != nil {
		t.Errorf("codemode without details = %+v, want a script without nested calls", cm.Codemode)
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
