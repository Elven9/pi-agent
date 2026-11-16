package sessionparser

import (
	"errors"
	"strings"
	"testing"
)

func TestToolCallsReturnsTheBranchsCallsWithResultsAndRefs(t *testing.T) {
	s, err := ParseFile("testdata/toolcalls.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	calls, err := s.ToolCalls()
	if err != nil {
		t.Fatal(err)
	}
	// c9 is on the abandoned branch.
	var got []string
	for _, c := range calls {
		got = append(got, c.ID+":"+c.Name)
	}
	if want := "c1:bash c2:read c3:bash c4:write"; strings.Join(got, " ") != want {
		t.Fatalf("calls = %s, want %s", strings.Join(got, " "), want)
	}

	c1 := calls[0]
	if string(c1.Args) != `{"command":"ls"}` || c1.EntryID != "a1" || c1.ArgsError != nil {
		t.Errorf("c1 = %+v", c1)
	}
	if c1.Ref == nil || *c1.Ref != 1 {
		t.Errorf("c1.Ref = %v, want 1", c1.Ref)
	}
	r := c1.Result
	if r == nil || r.EntryID != "r1" || r.IsError || r.Text() != "a\nb" || len(r.Content) != 1 {
		t.Fatalf("c1.Result = %+v", r)
	}
	if string(r.Details) != `{"exit":0}` || r.DurationMs == nil || *r.DurationMs != 12.5 {
		t.Errorf("details %s, duration %v", r.Details, r.DurationMs)
	}

	c2 := calls[1]
	if c2.Ref == nil || *c2.Ref != 2 || !c2.Result.IsError || c2.Result.Text() != "" {
		t.Errorf("c2 = %+v, result %+v", c2, c2.Result)
	}
	if img := c2.Result.Content[0]; img.Type != "image" || *img.MimeType != "image/png" || *img.Data != "aGk=" {
		t.Errorf("c2 image = %+v", img)
	}
	if c2.Result.Details != nil || c2.Result.DurationMs != nil {
		t.Errorf("c2 has details %s or duration %v, want none", c2.Result.Details, c2.Result.DurationMs)
	}

	c3 := calls[2]
	if c3.ArgsError == nil || *c3.ArgsError != "not JSON: {ls" || c3.Ref != nil || c3.Result == nil {
		t.Errorf("c3 = %+v", c3)
	}
	if c4 := calls[3]; c4.Result != nil || c4.Ref != nil {
		t.Errorf("c4 = %+v, want no result", c4)
	}
}

func TestToolCallsOnlyCountsAWholeTextBlockAsTheRef(t *testing.T) {
	s := parseLines(t,
		`{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash","arguments":{}}]}}`,
		`{"type":"message","id":"b","parentId":"a","timestamp":"2026-11-16T06:46:36Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text","text":"out\n[tool-ref #3]"}],"isError":false}}`,
	)
	calls, err := s.ToolCalls()
	if err != nil {
		t.Fatal(err)
	}
	if calls[0].Ref != nil || calls[0].Result.Text() != "out\n[tool-ref #3]" {
		t.Errorf("Ref = %v, text %q", calls[0].Ref, calls[0].Result.Text())
	}
}

func TestToolCallsWithoutCallsIsNil(t *testing.T) {
	calls, err := parseLines(t, entryLine("label", "a", "")).ToolCalls()
	if err != nil || calls != nil {
		t.Errorf("ToolCalls() = %v, %v; want nil, nil", calls, err)
	}
}

func TestToolCallsFailsOnAnInvalidMessage(t *testing.T) {
	const call = `{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash","arguments":{}}]}}`
	result := func(msg string) string {
		return `{"type":"message","id":"b","parentId":"a","timestamp":"2026-11-16T06:46:36Z","message":` + msg + "}"
	}
	tests := map[string][]string{
		"no message":            {`{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z"}`},
		"no role":               {`{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","message":{"content":[]}}`},
		"content not a list":    {`{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","message":{"role":"assistant","content":"hi"}}`},
		"call without id":       {`{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","arguments":{}}]}}`},
		"arguments not object":  {`{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash","arguments":[]}]}}`},
		"duplicate call id":     {call, `{"type":"message","id":"b","parentId":"a","timestamp":"2026-11-16T06:46:36Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"read","arguments":{}}]}}`},
		"result without call":   {call, result(`{"role":"toolResult","toolCallId":"zz","toolName":"bash","content":[],"isError":false}`)},
		"result of other tool":  {call, result(`{"role":"toolResult","toolCallId":"c1","toolName":"read","content":[],"isError":false}`)},
		"result without error":  {call, result(`{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[]}`)},
		"result content string": {call, result(`{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":"x","isError":false}`)},
		"text block no text":    {call, result(`{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text"}],"isError":false}`)},
		"second result": {call, result(`{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[],"isError":false}`),
			`{"type":"message","id":"c","parentId":"b","timestamp":"2026-11-16T06:46:36Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[],"isError":false}}`},
	}
	for name, lines := range tests {
		t.Run(name, func(t *testing.T) {
			_, err := parseLines(t, lines...).ToolCalls()
			var ee *EntryError
			if !errors.As(err, &ee) {
				t.Errorf("err = %v, want an EntryError", err)
			}
		})
	}
}
