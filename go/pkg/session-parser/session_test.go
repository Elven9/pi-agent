package sessionparser

import (
	"errors"
	"strings"
	"testing"
)

const header = `{"type":"session","version":3,"id":"s1","timestamp":"2026-11-16T06:46:35.781Z","cwd":"/w"}`

func TestParseReadsHeaderAndEntriesInFileOrder(t *testing.T) {
	in := header + "\n" +
		`{"type":"model_change","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36.775Z","provider":"cpa","modelId":"m"}` + "\n" +
		`{"type":"custom","customType":"pi-agent.tags","id":"b","parentId":"a","timestamp":"2026-11-16T06:46:37Z","data":{"tags":["x"]}}` + "\n"
	s, err := Parse(strings.NewReader(in))
	if err != nil {
		t.Fatal(err)
	}
	if s.Header.ID != "s1" || s.Header.Version != 3 || s.Header.CWD != "/w" {
		t.Errorf("header = %+v", s.Header)
	}
	if len(s.Entries) != 2 {
		t.Fatalf("got %d entries, want 2", len(s.Entries))
	}
	a, b := s.Entries[0], s.Entries[1]
	if a.Type != "model_change" || a.ID != "a" || a.ParentID != "" {
		t.Errorf("entry 0 = %+v", a)
	}
	if b.Type != "custom" || b.CustomType != "pi-agent.tags" || b.ParentID != "a" || b.Timestamp.IsZero() {
		t.Errorf("entry 1 = %+v", b)
	}
}

func TestParseKeepsTheWholeLineOfUnknownEntryTypes(t *testing.T) {
	line := `{"type":"from_the_future","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","extra":{"k":1}}`
	s, err := Parse(strings.NewReader(header + "\n" + line))
	if err != nil {
		t.Fatal(err)
	}
	if got := string(s.Entries[0].Raw); got != line {
		t.Errorf("Raw = %s, want %s", got, line)
	}
}

func TestParseSkipsBlankLines(t *testing.T) {
	in := "\n" + header + "\n\n  \n" + `{"type":"label","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z"}` + "\r\n\n"
	s, err := Parse(strings.NewReader(in))
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Entries) != 1 {
		t.Errorf("got %d entries, want 1", len(s.Entries))
	}
}

func TestParseReadsLinesLongerThanAScannerBuffer(t *testing.T) {
	big := strings.Repeat("x", 1<<20)
	in := header + "\n" + `{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","text":"` + big + `"}`
	s, err := Parse(strings.NewReader(in))
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Entries[0].Raw) < len(big) {
		t.Errorf("Raw has %d bytes", len(s.Entries[0].Raw))
	}
}

func TestParseRequiresASessionHeaderFirst(t *testing.T) {
	for name, in := range map[string]string{
		"empty":             "",
		"blank":             "\n \n",
		"entry first":       `{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z"}`,
		"header without id": `{"type":"session","version":3}`,
		"not json":          "nope",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse(strings.NewReader(in)); !errors.Is(err, ErrNoHeader) {
				t.Errorf("err = %v, want ErrNoHeader", err)
			}
		})
	}
}

func TestParseReportsTheLineOfAnInvalidEntry(t *testing.T) {
	for name, line := range map[string]string{
		"not json": `{"type":"message",`,
		"no type":  `{"id":"a"}`,
		"bad time": `{"type":"message","timestamp":"yesterday"}`,
	} {
		t.Run(name, func(t *testing.T) {
			in := header + "\n" + `{"type":"label","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z"}` + "\n" + line + "\n"
			_, err := Parse(strings.NewReader(in))
			var le *LineError
			if !errors.As(err, &le) || le.Line != 3 {
				t.Errorf("err = %v, want a LineError on line 3", err)
			}
		})
	}
}

func TestFormatVersionIsOneWhenTheHeaderHasNone(t *testing.T) {
	if got := (Header{}).FormatVersion(); got != 1 {
		t.Errorf("FormatVersion() = %d, want 1", got)
	}
	if got := (Header{Version: 3}).FormatVersion(); got != 3 {
		t.Errorf("FormatVersion() = %d, want 3", got)
	}
}

func TestAgentVersionIsTheLastValidSessionVersionEntry(t *testing.T) {
	entry := func(id, data string) string {
		return `{"type":"custom","customType":"pi-agent.session-version","id":"` + id + `","parentId":null,"timestamp":"2026-11-16T06:46:36Z","data":` + data + "}\n"
	}
	tests := []struct {
		name    string
		entries string
		want    string
	}{
		{"none", "", ""},
		{"one", entry("a", `{"version":"0.11.0"}`), "0.11.0"},
		{"resumed by a newer release", entry("a", `{"version":"0.11.0"}`) + entry("b", `{"version":"0.12.0"}`), "0.12.0"},
		{"malformed last entry", entry("a", `{"version":"0.11.0"}`) + entry("b", `{"version":3}`), "0.11.0"},
		{"other custom entry", `{"type":"custom","customType":"pi-agent.tags","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","data":{"version":"1"}}` + "\n", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, err := Parse(strings.NewReader(header + "\n" + tt.entries))
			if err != nil {
				t.Fatal(err)
			}
			if got := s.AgentVersion(); got != tt.want {
				t.Errorf("AgentVersion() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestParseFileReadsARealRunnerSession(t *testing.T) {
	// The runner's demo session, shared with the TypeScript tests.
	s, err := ParseFile("../../../testdata/demo-run.session.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if s.Header.FormatVersion() != 3 || len(s.Entries) != 12 {
		t.Errorf("format %d, %d entries", s.Header.FormatVersion(), len(s.Entries))
	}
	for i, e := range s.Entries {
		if e.ID == "" || e.Timestamp.IsZero() {
			t.Errorf("entry %d = %+v", i, e)
		}
	}
}
