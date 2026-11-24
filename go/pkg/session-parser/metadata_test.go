package sessionparser

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

// parseLines parses a session made of the header and the given entry lines.
func parseLines(t *testing.T, entries ...string) *Session {
	t.Helper()
	s, err := Parse(strings.NewReader(header + "\n" + strings.Join(entries, "\n")))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestMetadataReadsFileWideValuesAndTheBranchsModelsAndErrors(t *testing.T) {
	s, err := ParseFile("testdata/metadata.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	m, err := s.Metadata()
	if err != nil {
		t.Fatal(err)
	}
	if m.SessionID != "s1" || m.CWD != "/w" || m.FormatVersion != 3 || m.ParentSession == nil || *m.ParentSession != "/sessions/old.jsonl" {
		t.Errorf("header fields = %+v", m)
	}
	if m.AgentVersion == nil || *m.AgentVersion != "0.12.0" {
		t.Errorf("AgentVersion = %v, want 0.12.0", m.AgentVersion)
	}
	wantTags := &Tags{Tags: []string{"bug", "ui"}, Source: "command", At: time.Date(2026, 11, 16, 7, 0, 0, 0, time.UTC)}
	if !reflect.DeepEqual(m.Tags, wantTags) {
		t.Errorf("Tags = %+v, want %+v", m.Tags, wantTags)
	}
	if m.Name == nil || *m.Name != "fix login" {
		t.Errorf("Name = %v", m.Name)
	}
	var models []string
	for _, mc := range m.Models {
		models = append(models, mc.Provider+"/"+mc.ModelID)
	}
	// m2 (haiku) and x1 are on the abandoned branch.
	if got := strings.Join(models, ","); got != "cpa/opus,cpa/sonnet" {
		t.Errorf("Models = %s", got)
	}
	if len(m.Errors) != 1 || m.Errors[0].Message != "--tags: Invalid tag" {
		t.Errorf("Errors = %+v", m.Errors)
	}
	if m.Scenario == nil || *m.Scenario != "code-writer" {
		t.Errorf("Scenario = %v, want code-writer", m.Scenario)
	}
	// pl1 is off the current branch: the link belongs to the whole file.
	wantParent := &ParentLink{SessionID: "lead-1", AgentID: "a3", At: time.Date(2026, 11, 16, 7, 0, 30, 0, time.UTC)}
	if !reflect.DeepEqual(m.Parent, wantParent) {
		t.Errorf("Parent = %+v, want %+v", m.Parent, wantParent)
	}
	wantProject := &Project{Name: "pi-agent", Source: ProjectSource{Kind: ProjectLocal, Dir: "/w/project"}, At: time.Date(2026, 11, 16, 7, 1, 0, 0, time.UTC)}
	if !reflect.DeepEqual(m.Project, wantProject) {
		t.Errorf("Project = %+v, want %+v", m.Project, wantProject)
	}
}

func TestMetadataReadsARemoteProject(t *testing.T) {
	m, err := parseLines(t,
		`{"type":"custom","customType":"pi-agent.project","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","data":{"version":1,"name":"p","source":{"kind":"remote","provider":"github","repo":"o/r","path":"proj","tag":"v1","commit":"abc"}}}`,
	).Metadata()
	if err != nil {
		t.Fatal(err)
	}
	want := ProjectSource{Kind: ProjectRemote, Provider: "github", Repo: "o/r", Path: "proj", Tag: "v1", Commit: "abc"}
	if m.Project == nil || m.Project.Source != want {
		t.Errorf("Project = %+v, want source %+v", m.Project, want)
	}
}

func TestMetadataHasNoScenarioOrProjectAfterAnEntryThatDropsThem(t *testing.T) {
	m, err := parseLines(t,
		`{"type":"custom","customType":"pi-agent.scenario","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","data":{"version":1,"name":"debugger"}}`,
		`{"type":"custom","customType":"pi-agent.project","id":"b","parentId":"a","timestamp":"2026-11-16T06:46:36Z","data":{"version":1,"name":"p","source":{"kind":"local","dir":"/p"}}}`,
		`{"type":"custom","customType":"pi-agent.scenario","id":"c","parentId":"b","timestamp":"2026-11-16T06:46:36Z","data":{"version":1,"name":null}}`,
		`{"type":"custom","customType":"pi-agent.project","id":"d","parentId":"c","timestamp":"2026-11-16T06:46:36Z","data":{"version":1,"name":null}}`,
	).Metadata()
	if err != nil {
		t.Fatal(err)
	}
	if m.Scenario != nil || m.Project != nil {
		t.Errorf("Scenario = %v, Project = %+v; want nil", m.Scenario, m.Project)
	}
}

func TestMetadataLeavesWhatTheFileDoesNotHaveNil(t *testing.T) {
	m, err := parseLines(t, entryLine("message", "a", "")).Metadata()
	if err != nil {
		t.Fatal(err)
	}
	if m.ParentSession != nil || m.AgentVersion != nil || m.Tags != nil || m.Name != nil || m.Models != nil || m.Errors != nil ||
		m.Scenario != nil || m.Project != nil || m.Parent != nil {
		t.Errorf("Metadata = %+v, want only header fields", m)
	}
}

func TestMetadataLastActivityIsTheNewestUserOrAssistantMessageOnAnyBranch(t *testing.T) {
	msg := func(id, parent, ts, role string) string {
		return `{"type":"message","id":"` + id + `","parentId":` + parent + `,"timestamp":"` + ts + `","message":{"role":"` + role + `","content":[],"timestamp":1}}`
	}
	m, err := parseLines(t,
		msg("u1", "null", "2026-11-16T07:00:00Z", "user"),
		// The abandoned branch has the newest reply.
		msg("a1", `"u1"`, "2026-11-16T09:00:00Z", "assistant"),
		msg("t1", `"a1"`, "2026-11-16T09:30:00Z", "toolResult"),
		// The current branch: newer entries, but none of them user or assistant messages.
		msg("u2", `"u1"`, "2026-11-16T08:00:00Z", "user"),
		`{"type":"model_change","id":"m1","parentId":"u2","timestamp":"2026-11-16T10:00:00Z","provider":"cpa","modelId":"opus"}`,
		`{"type":"custom","customType":"pi-agent.session-version","id":"v1","parentId":"m1","timestamp":"2026-11-16T10:01:00Z","data":{"version":"0.12.0"}}`,
		`{"type":"session_info","id":"i1","parentId":"v1","timestamp":"2026-11-16T10:02:00Z","name":"x"}`,
	).Metadata()
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, 11, 16, 9, 0, 0, 0, time.UTC); !m.LastActivityAt.Equal(want) {
		t.Errorf("LastActivityAt = %v, want %v (the entry time of the abandoned branch's reply)", m.LastActivityAt, want)
	}
}

func TestMetadataLastActivityIsTheStartWithoutUserOrAssistantMessages(t *testing.T) {
	m, err := parseLines(t,
		`{"type":"model_change","id":"m1","parentId":null,"timestamp":"2026-11-16T10:00:00Z","provider":"cpa","modelId":"opus"}`,
		entryLine("message", "x", "m1"), // no message payload: not a conversation message
	).Metadata()
	if err != nil {
		t.Fatal(err)
	}
	if !m.LastActivityAt.Equal(m.StartedAt) || m.StartedAt.IsZero() {
		t.Errorf("LastActivityAt = %v, want StartedAt %v", m.LastActivityAt, m.StartedAt)
	}
}

func TestMetadataKeepsClearedTagsAsAnEmptyList(t *testing.T) {
	m, err := parseLines(t,
		`{"type":"custom","customType":"pi-agent.tags","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","data":{"version":1,"tags":[],"source":"command"}}`,
	).Metadata()
	if err != nil {
		t.Fatal(err)
	}
	if m.Tags == nil || m.Tags.Tags == nil || len(m.Tags.Tags) != 0 {
		t.Errorf("Tags = %+v, want present and empty", m.Tags)
	}
}

func TestMetadataReadsTheDefaultTagsSource(t *testing.T) {
	m, err := parseLines(t,
		`{"type":"custom","customType":"pi-agent.tags","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","data":{"version":1,"tags":["my-repo"],"source":"default"}}`,
	).Metadata()
	if err != nil {
		t.Fatal(err)
	}
	want := &Tags{Tags: []string{"my-repo"}, Source: "default", At: time.Date(2026, 11, 16, 6, 46, 36, 0, time.UTC)}
	if !reflect.DeepEqual(m.Tags, want) {
		t.Errorf("Tags = %+v, want %+v", m.Tags, want)
	}
}

func TestMetadataNameIsNilAfterTheNameIsCleared(t *testing.T) {
	m, err := parseLines(t,
		`{"type":"session_info","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","name":"x"}`,
		`{"type":"session_info","id":"b","parentId":"a","timestamp":"2026-11-16T06:46:36Z"}`,
	).Metadata()
	if err != nil {
		t.Fatal(err)
	}
	if m.Name != nil {
		t.Errorf("Name = %q, want nil", *m.Name)
	}
}

func TestMetadataFailsOnAnInvalidEntry(t *testing.T) {
	custom := func(customType, data string) string {
		return `{"type":"custom","customType":"` + customType + `","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","data":` + data + "}"
	}
	tests := map[string]string{
		"version not a string": custom(CustomTypeSessionVersion, `{"version":3}`),
		"empty version":        custom(CustomTypeSessionVersion, `{"version":""}`),
		"no data":              `{"type":"custom","customType":"pi-agent.tags","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z"}`,
		"tags without list":    custom(CustomTypeTags, `{"version":1,"source":"flag"}`),
		"tags bad source":      custom(CustomTypeTags, `{"version":1,"tags":[],"source":"api"}`),
		"tags not strings":     custom(CustomTypeTags, `{"version":1,"tags":[1],"source":"flag"}`),
		"error without text":   custom(CustomTypeError, `{}`),
		"model without id":     `{"type":"model_change","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","provider":"cpa"}`,
		"name not a string":    `{"type":"session_info","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","name":1}`,
		"scenario no version":  custom(CustomTypeScenario, `{"name":"x"}`),
		"scenario empty name":  custom(CustomTypeScenario, `{"version":1,"name":""}`),
		"project no source":    custom(CustomTypeProject, `{"version":1,"name":"p"}`),
		"project bad kind":     custom(CustomTypeProject, `{"version":1,"name":"p","source":{"kind":"ftp"}}`),
		"local without dir":    custom(CustomTypeProject, `{"version":1,"name":"p","source":{"kind":"local"}}`),
		"remote without tag":   custom(CustomTypeProject, `{"version":1,"name":"p","source":{"kind":"remote","provider":"github","repo":"o/r","commit":"c"}}`),
		"parent without agent": custom(CustomTypeParent, `{"sessionId":"lead-1"}`),
		"parent empty session": custom(CustomTypeParent, `{"sessionId":"","agentId":"a3"}`),
		"message not object":   `{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","message":"hi"}`,
	}
	for name, line := range tests {
		t.Run(name, func(t *testing.T) {
			_, err := parseLines(t, line).Metadata()
			var ee *EntryError
			if !errors.As(err, &ee) || ee.ID != "a" {
				t.Errorf("err = %v, want an EntryError for entry a", err)
			}
		})
	}
}

func TestMetadataFailsOnAnUnsupportedTagsVersion(t *testing.T) {
	_, err := parseLines(t,
		`{"type":"custom","customType":"pi-agent.tags","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","data":{"version":2,"tags":[],"source":"flag"}}`,
	).Metadata()
	var ve *UnsupportedVersionError
	if !errors.As(err, &ve) || ve.Version != 2 {
		t.Errorf("err = %v, want UnsupportedVersionError for version 2", err)
	}
}
