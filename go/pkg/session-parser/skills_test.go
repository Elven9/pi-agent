package sessionparser

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func readSkills(t *testing.T, s *Session) *Skills {
	t.Helper()
	sk, err := s.Skills()
	if err != nil {
		t.Fatal(err)
	}
	return sk
}

func TestSkillsListsTheSkillsOfTheSystemPrompt(t *testing.T) {
	s, err := ParseFile("testdata/skills.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	want := []Skill{
		{Name: "golang", Description: "Go & tests", Location: "/s/golang/SKILL.md"},
		{Name: "pdf-tools", Description: "PDFs", Location: "/s/pdf/SKILL.md"},
	}
	if got := readSkills(t, s).Available; !reflect.DeepEqual(got, want) {
		t.Errorf("Available = %+v, want %+v", got, want)
	}
}

func TestSkillsFindsLoadsByCommandReadAndCodemodeOnTheBranch(t *testing.T) {
	s, err := ParseFile("testdata/skills.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	at := func(sec int) time.Time { return time.Date(2026, 11, 16, 6, 46, sec, 0, time.UTC) }
	// /s/other/SKILL.md is read on the abandoned branch; notes.md is no skill.
	want := []SkillUse{
		{Name: "pdf-tools", Location: "/s/pdf/SKILL.md", Loads: []SkillLoad{
			{Via: SkillViaCommand, EntryID: "u1", At: at(37)},
		}},
		{Name: "golang", Location: "/s/golang/SKILL.md", Loads: []SkillLoad{
			{Via: SkillViaRead, CallID: "c1", EntryID: "a1", At: at(38)},
			{Via: SkillViaCodemode, CallID: "cm/1", EntryID: "a2", At: at(41)},
		}},
		{Name: "unlisted", Location: "/x/unlisted/SKILL.md", Loads: []SkillLoad{
			{Via: SkillViaCodemode, CallID: "cm/3", EntryID: "a2", At: at(41), Failed: true},
		}},
	}
	if got := readSkills(t, s).Used; !reflect.DeepEqual(got, want) {
		t.Errorf("Used =\n%+v\nwant\n%+v", got, want)
	}
}

const skillsSystem = `{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","message":{"role":"system","content":"","sections":{"skills":"<skill>\n<name>go</name>\n<description>d</description>\n<location>/s/go/SKILL.md</location>\n</skill>"}}}`

func TestSkillsFollowsLaterSystemMessagesThatPatchTheSkillsSection(t *testing.T) {
	sk := readSkills(t, parseLines(t, skillsSystem,
		`{"type":"message","id":"b","parentId":"a","timestamp":"2026-11-16T06:46:36Z","message":{"role":"system","content":"","sections":{"cwd":"/w"}}}`,
	))
	if len(sk.Available) != 1 || sk.Available[0].Name != "go" {
		t.Errorf("after a patch without skills: Available = %+v, want go", sk.Available)
	}
	sk = readSkills(t, parseLines(t, skillsSystem,
		`{"type":"message","id":"b","parentId":"a","timestamp":"2026-11-16T06:46:36Z","message":{"role":"system","content":"","sections":{"skills":null}}}`,
	))
	if sk.Available != nil {
		t.Errorf("after removing skills: Available = %+v, want nil", sk.Available)
	}
}

func TestSkillsTakesACompactionCheckpointAsTheWholePrompt(t *testing.T) {
	sk := readSkills(t, parseLines(t, skillsSystem,
		`{"type":"compaction","id":"b","parentId":"a","timestamp":"2026-11-16T06:46:36Z","summary":"s","firstKeptEntryId":"a","tokensBefore":1,"systemMessage":{"role":"system","content":"","sections":{"cwd":"/w"}}}`,
	))
	if sk.Available != nil {
		t.Errorf("Available = %+v, want nil after a checkpoint without skills", sk.Available)
	}
}

func TestSkillsNamesAReadByTheListedSkillEvenAfterItLeftThePrompt(t *testing.T) {
	sk := readSkills(t, parseLines(t, skillsSystem,
		`{"type":"message","id":"b","parentId":"a","timestamp":"2026-11-16T06:46:36Z","message":{"role":"system","content":"","sections":{"skills":null}}}`,
		`{"type":"message","id":"c","parentId":"b","timestamp":"2026-11-16T06:46:36Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"read","arguments":{"path":"/s/go/SKILL.md"}}]}}`,
	))
	if len(sk.Used) != 1 || sk.Used[0].Name != "go" {
		t.Errorf("Used = %+v, want go", sk.Used)
	}
}

func TestSkillsMarksAReadThatFailed(t *testing.T) {
	sk := readSkills(t, parseLines(t,
		`{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"read","arguments":{"path":"/s/go/SKILL.md"}}]}}`,
		`{"type":"message","id":"b","parentId":"a","timestamp":"2026-11-16T06:46:36Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"read","content":[],"isError":true}}`,
	))
	if len(sk.Used) != 1 || !sk.Used[0].Loads[0].Failed {
		t.Errorf("Used = %+v, want one failed load", sk.Used)
	}
}

func TestSkillsSkipsACodemodeReadWhosePathWasCut(t *testing.T) {
	sk := readSkills(t, parseLines(t,
		`{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"codemode","arguments":{}}]}}`,
		`{"type":"message","id":"b","parentId":"a","timestamp":"2026-11-16T06:46:36Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"codemode","content":[],"isError":false,"details":{"calls":[{"id":"c1/1","name":"read","args":"{\"path\":\"/very/long/SKI...","status":"ok"}]}}}`,
	))
	if sk.Used != nil {
		t.Errorf("Used = %+v, want nil", sk.Used)
	}
}

func TestSkillsOfASessionWithoutSkillsIsEmpty(t *testing.T) {
	sk := readSkills(t, parseLines(t,
		`{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","message":{"role":"user","content":"hi"}}`,
	))
	if sk.Available != nil || sk.Used != nil {
		t.Errorf("Skills = %+v, want empty", sk)
	}
}

func TestSkillsFailsOnAnInvalidSystemMessage(t *testing.T) {
	_, err := parseLines(t,
		`{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","message":{"role":"system","content":"","sections":{"skills":1}}}`,
	).Skills()
	var ee *EntryError
	if !errors.As(err, &ee) || ee.ID != "a" {
		t.Errorf("err = %v, want an EntryError for entry a", err)
	}
}

func skillLoadLine(id, parent, data string) string {
	return `{"type":"custom","customType":"pi-agent.skill-load","id":"` + id + `","parentId":"` + parent + `","timestamp":"2026-11-16T06:46:40Z","data":` + data + `}`
}

func TestSkillsPrefersRecordedLoadsOverTheTranscript(t *testing.T) {
	// The assistant read in "r" would be inferred as a load; the recorded entries win.
	sk := readSkills(t, parseLines(t, skillsSystem,
		`{"type":"message","id":"r","parentId":"a","timestamp":"2026-11-16T06:46:37Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c0","name":"read","arguments":{"path":"/s/go/SKILL.md"}}]}}`,
		skillLoadLine("l1", "r", `{"version":1,"name":"go","location":"/s/go/SKILL.md","via":"codemode","toolCallId":"cm/1"}`),
		skillLoadLine("l2", "l1", `{"version":1,"name":"pdf","location":"/s/pdf/SKILL.md","via":"command"}`),
		skillLoadLine("l3", "l2", `{"version":1,"name":"go","location":"/s/go/SKILL.md","via":"read","toolCallId":"c9"}`),
	))
	at := time.Date(2026, 11, 16, 6, 46, 40, 0, time.UTC)
	want := []SkillUse{
		{Name: "go", Location: "/s/go/SKILL.md", Loads: []SkillLoad{
			{Via: SkillViaCodemode, CallID: "cm/1", EntryID: "l1", At: at},
			{Via: SkillViaRead, CallID: "c9", EntryID: "l3", At: at},
		}},
		{Name: "pdf", Location: "/s/pdf/SKILL.md", Loads: []SkillLoad{{Via: SkillViaCommand, EntryID: "l2", At: at}}},
	}
	if !sk.Recorded || !reflect.DeepEqual(sk.Used, want) {
		t.Errorf("Recorded = %v, Used =\n%+v\nwant\n%+v", sk.Recorded, sk.Used, want)
	}
	if len(sk.Available) != 1 {
		t.Errorf("Available = %+v, want the prompt's skill", sk.Available)
	}
}

func TestSkillsReadsTheTranscriptWithoutRecordedLoads(t *testing.T) {
	s, err := ParseFile("testdata/skills.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if sk := readSkills(t, s); sk.Recorded || len(sk.Used) == 0 {
		t.Errorf("Recorded = %v, Used = %+v; want transcript loads", sk.Recorded, sk.Used)
	}
}

func TestSkillsRejectsInvalidRecordedLoads(t *testing.T) {
	for name, data := range map[string]string{
		"no version":    `{"name":"go","location":"/s/go/SKILL.md","via":"read"}`,
		"no name":       `{"version":1,"location":"/s/go/SKILL.md","via":"read"}`,
		"no location":   `{"version":1,"name":"go","via":"read"}`,
		"unknown via":   `{"version":1,"name":"go","location":"/s/go/SKILL.md","via":"cat"}`,
		"null data":     `null`,
		"wrong id type": `{"version":1,"name":"go","location":"/s/go/SKILL.md","via":"read","toolCallId":3}`,
	} {
		_, err := parseLines(t, skillsSystem, skillLoadLine("l1", "a", data)).Skills()
		var entryErr *EntryError
		if !errors.As(err, &entryErr) || entryErr.ID != "l1" {
			t.Errorf("%s: err = %v, want an EntryError for l1", name, err)
		}
	}
	_, err := parseLines(t, skillsSystem, skillLoadLine("l1", "a", `{"version":2,"name":"go","location":"/x","via":"read"}`)).Skills()
	var versionErr *UnsupportedVersionError
	if !errors.As(err, &versionErr) || versionErr.Version != 2 || versionErr.CustomType != CustomTypeSkillLoad {
		t.Errorf("version 2: err = %v, want an UnsupportedVersionError", err)
	}
}
