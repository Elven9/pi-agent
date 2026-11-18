package sessionparser

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestSubagentsJoinStartsWithTheirResultsOnTheBranch(t *testing.T) {
	s, err := ParseFile("testdata/subagents.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	agents, err := s.Subagents()
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, a := range agents {
		got = append(got, a.ID)
	}
	// a9 was started on the abandoned branch.
	if strings.Join(got, ",") != "a1,a2,a3,a4" {
		t.Fatalf("agents = %v", got)
	}

	a1 := agents[0]
	if a1.Scenario != "code-writer" || a1.Kind != "task" || a1.Task != "t" || *a1.Project != "/p" || a1.StartedBy != "model" ||
		a1.RestartOf != nil || a1.TaskMessageID != "msg_1" || a1.EntryID != "s1e" || !a1.StartedAt.Equal(time.UnixMilli(1763275596000)) {
		t.Errorf("a1 = %+v", a1)
	}
	r := a1.Result
	if r == nil || r.Status != SubagentOK || r.Summary != "done" || !r.Delivered || r.EntryID != "r1" || r.MessageID != "msg_r_a1" ||
		*r.DetailKind != "code-writer/v1" || string(r.Detail) != `{"files":["x.go"]}` || *r.ChildSessionFile != "/sessions/subagents/a1.jsonl" ||
		r.Reason != nil || !r.EndedAt.Equal(time.UnixMilli(1763275600000)) {
		t.Errorf("a1.Result = %+v", r)
	}

	// a2: an end record, then a result message (wins), then a later end record (ignored).
	if r := agents[1].Result; r == nil || r.Status != SubagentKilled || *r.Reason != "user" || !r.Delivered || r.EntryID != "r2" {
		t.Errorf("a2.Result = %+v", r)
	}
	if a3 := agents[2]; a3.RestartOf == nil || *a3.RestartOf != "a2" || a3.StartedBy != "user" || a3.Result != nil {
		t.Errorf("a3 = %+v", a3)
	}
	if a4 := agents[3]; a4.Result != nil || a4.Project != nil {
		t.Errorf("a4 = %+v", a4)
	}
}

func TestSubagentsUseAnEndRecordWhenNoResultWasDelivered(t *testing.T) {
	s := parseLines(t,
		`{"type":"custom","customType":"subagent-start","id":"s","parentId":null,"timestamp":"2026-11-16T06:46:36Z","data":{"id":1,"scenario":"x","kind":"task","task":"t","startedAt":1,"taskMessageId":"m"}}`,
		`{"type":"custom","customType":"subagent-end","id":"e","parentId":"s","timestamp":"2026-11-16T06:46:36Z","data":{"result":{"agentId":"a1","resultId":"a1","endedAt":2,"envelope":{"v":1,"id":"m2","body":{"status":"aborted","reason":"reload","summary":"aborted"}}}}}`,
	)
	agents, err := s.Subagents()
	if err != nil {
		t.Fatal(err)
	}
	if r := agents[0].Result; r == nil || r.Delivered || r.Status != SubagentAborted || *r.Reason != "reload" || r.Detail != nil {
		t.Errorf("Result = %+v", r)
	}
}

func TestSubagentsStartedWithoutAScenarioHaveAnEmptyScenario(t *testing.T) {
	agents, err := parseLines(t,
		`{"type":"custom","customType":"subagent-start","id":"s","parentId":null,"timestamp":"2026-11-16T06:46:36Z","data":{"id":1,"kind":"task","task":"t","startedAt":1,"taskMessageId":"m"}}`,
	).Subagents()
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 1 || agents[0].Scenario != "" || agents[0].Task != "t" {
		t.Errorf("agents = %+v", agents)
	}
}

func TestSubagentsOfABranchWithoutSubagentsIsNil(t *testing.T) {
	agents, err := parseLines(t, entryLine("message", "a", "")).Subagents()
	if err != nil || agents != nil {
		t.Errorf("Subagents() = %v, %v; want nil, nil", agents, err)
	}
}

func TestSubagentsFailOnAnInvalidRecord(t *testing.T) {
	start := func(data string) string {
		return `{"type":"custom","customType":"subagent-start","id":"s","parentId":null,"timestamp":"2026-11-16T06:46:36Z","data":` + data + "}"
	}
	const ok = `{"id":1,"scenario":"x","kind":"task","task":"t","startedAt":1,"taskMessageId":"m"}`
	result := func(details string) string {
		return `{"type":"custom_message","customType":"subagent-result","id":"r","parentId":"s","timestamp":"2026-11-16T06:46:36Z","content":"x","display":true,"details":` + details + "}"
	}
	const body = `{"status":"ok","summary":"done"}`
	res := func(agent, envelope string) string {
		return `{"agentId":"` + agent + `","resultId":"` + agent + `","endedAt":2,"envelope":` + envelope + "}"
	}
	tests := map[string][]string{
		"start without id":       {start(`{"scenario":"x","kind":"task","task":"t","startedAt":1,"taskMessageId":"m"}`)},
		"start without task":     {start(`{"id":1,"scenario":"x","kind":"task","startedAt":1,"taskMessageId":"m"}`)},
		"start of other kind":    {start(strings.Replace(ok, "task\",\"task", "herd\",\"task", 1))},
		"start bad startedBy":    {start(strings.Replace(ok, `"id":1`, `"id":1,"startedBy":"cron"`, 1))},
		"second start":           {start(ok), `{"type":"custom","customType":"subagent-start","id":"s2","parentId":"s","timestamp":"2026-11-16T06:46:36Z","data":` + ok + "}"},
		"result never started":   {start(ok), result(res("a7", `{"v":1,"id":"m2","body":`+body+"}"))},
		"result bad agent id":    {start(ok), result(res("x1", `{"v":1,"id":"m2","body":`+body+"}"))},
		"result without details": {start(ok), `{"type":"custom_message","customType":"subagent-result","id":"r","parentId":"s","timestamp":"2026-11-16T06:46:36Z","content":"x","display":true}`},
		"result no envelope":     {start(ok), result(`{"agentId":"a1","resultId":"a1","endedAt":2}`)},
		"result unknown status":  {start(ok), result(res("a1", `{"v":1,"id":"m2","body":{"status":"lost","summary":"?"}}`))},
		"result no summary":      {start(ok), result(res("a1", `{"v":1,"id":"m2","body":{"status":"ok"}}`))},
		"end without result":     {start(ok), `{"type":"custom","customType":"subagent-end","id":"e","parentId":"s","timestamp":"2026-11-16T06:46:36Z","data":{}}`},
	}
	for name, lines := range tests {
		t.Run(name, func(t *testing.T) {
			_, err := parseLines(t, lines...).Subagents()
			var ee *EntryError
			if !errors.As(err, &ee) {
				t.Errorf("err = %v, want an EntryError", err)
			}
		})
	}
	t.Run("other envelope version", func(t *testing.T) {
		_, err := parseLines(t, start(ok), result(res("a1", `{"v":2,"id":"m2","body":`+body+"}"))).Subagents()
		var ve *UnsupportedVersionError
		if !errors.As(err, &ve) || ve.Version != 2 {
			t.Errorf("err = %v, want UnsupportedVersionError", err)
		}
	})
}
