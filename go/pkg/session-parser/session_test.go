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
		"not json":       `{"type":"message",`,
		"no type":        `{"id":"a"}`,
		"bad time":       `{"type":"message","id":"b","parentId":"a","timestamp":"yesterday"}`,
		"no id":          `{"type":"message","parentId":"a","timestamp":"2026-11-16T06:46:36Z"}`,
		"same id":        `{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z"}`,
		"unknown parent": `{"type":"message","id":"b","parentId":"zz","timestamp":"2026-11-16T06:46:36Z"}`,
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

func TestParseRejectsOtherFormatVersions(t *testing.T) {
	for name, h := range map[string]string{
		"no version (format 1)": `{"type":"session","id":"s1","timestamp":"2026-11-16T06:46:35Z","cwd":"/w"}`,
		"format 2":              `{"type":"session","version":2,"id":"s1","timestamp":"2026-11-16T06:46:35Z","cwd":"/w"}`,
		"newer format":          `{"type":"session","version":4,"id":"s1","timestamp":"2026-11-16T06:46:35Z","cwd":"/w"}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse(strings.NewReader(h)); !errors.Is(err, ErrUnsupportedFormat) {
				t.Errorf("err = %v, want ErrUnsupportedFormat", err)
			}
		})
	}
}

// entryLine is a minimal entry of type typ.
func entryLine(typ, id, parent string) string {
	p := "null"
	if parent != "" {
		p = `"` + parent + `"`
	}
	return `{"type":"` + typ + `","id":"` + id + `","parentId":` + p + `,"timestamp":"2026-11-16T06:46:36Z"}` + "\n"
}

func ids(entries []Entry) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.ID
	}
	return out
}

func TestBranchFollowsParentsFromTheLastEntryToTheRoot(t *testing.T) {
	// a ─ b ─ c (abandoned)
	//       └ d ─ e (current: last in the file)
	in := header + "\n" + entryLine("message", "a", "") + entryLine("message", "b", "a") +
		entryLine("message", "c", "b") + entryLine("message", "d", "b") + entryLine("label", "e", "d")
	s, err := Parse(strings.NewReader(in))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(ids(s.Branch()), ","), "a,b,d,e"; got != want {
		t.Errorf("Branch() = %s, want %s", got, want)
	}
}

func TestBranchOfASessionWithoutEntriesIsEmpty(t *testing.T) {
	s, err := Parse(strings.NewReader(header))
	if err != nil {
		t.Fatal(err)
	}
	if b := s.Branch(); len(b) != 0 {
		t.Errorf("Branch() = %v, want empty", ids(b))
	}
}
