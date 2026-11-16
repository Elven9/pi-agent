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
}

func TestMetadataLeavesWhatTheFileDoesNotHaveNil(t *testing.T) {
	m, err := parseLines(t, entryLine("message", "a", "")).Metadata()
	if err != nil {
		t.Fatal(err)
	}
	if m.ParentSession != nil || m.AgentVersion != nil || m.Tags != nil || m.Name != nil || m.Models != nil || m.Errors != nil {
		t.Errorf("Metadata = %+v, want only header fields", m)
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
