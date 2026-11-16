package sessionparser

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestMetricsAreTheNewestTotalsOnTheBranchWithEverySample(t *testing.T) {
	s, err := ParseFile("testdata/metrics.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	m, err := s.Metrics()
	if err != nil {
		t.Fatal(err)
	}
	if m == nil {
		t.Fatal("Metrics() = nil")
	}
	// k9 is on the abandoned branch: its turns and samples don't count.
	if m.EntryID != "k2" || m.Entries != 2 || m.Turns != 2 || m.CostUSD != 0.03 || m.Compactions != 0 {
		t.Errorf("metrics = %+v", m)
	}
	if m.Tokens != (Tokens{Input: 300, Output: 30, CacheRead: 200, CacheWrite: 40}) {
		t.Errorf("Tokens = %+v", m.Tokens)
	}
	if m.Model.Calls != 2 || *m.Model.TTFTMsP50 != 250 || *m.Model.LatencyMsMax != 1000 {
		t.Errorf("Model = %+v", m.Model)
	}
	if m.Tools["bash"] != (ToolMetrics{Calls: 2, Errors: 1, MsP50: 40, MsMax: 60}) || m.Tools["read"].Calls != 1 {
		t.Errorf("Tools = %+v", m.Tools)
	}
	if m.ContextPeakPercent == nil || *m.ContextPeakPercent != 12.5 {
		t.Errorf("ContextPeakPercent = %v", m.ContextPeakPercent)
	}
	if !reflect.DeepEqual(m.CacheMisses, []CacheMiss{{Turn: 2, Expected: 70, CacheRead: 0}}) {
		t.Errorf("CacheMisses = %+v", m.CacheMisses)
	}
	want := Samples{
		TTFTMs:    []float64{300, 200},
		LatencyMs: []float64{900, 1000},
		ToolMs:    map[string][]float64{"bash": {40, 60}, "read": {5}},
	}
	if !reflect.DeepEqual(m.Samples, want) {
		t.Errorf("Samples = %+v, want %+v", m.Samples, want)
	}
}

func TestMetricsKeepNullTimesAsNil(t *testing.T) {
	s := parseLines(t, `{"type":"custom","customType":"pi-agent.metrics","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","data":`+
		`{"version":1,"tokens":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"costUsd":0,"turns":0,`+
		`"model":{"calls":0,"ttftMsP50":null,"latencyMsP50":null,"latencyMsMax":null},"tools":{},"compactions":0,`+
		`"contextPeakPercent":null,"cacheMisses":[],"samples":{"ttftMs":[],"latencyMs":[],"toolMs":{}}}}`)
	m, err := s.Metrics()
	if err != nil {
		t.Fatal(err)
	}
	if m.Model.TTFTMsP50 != nil || m.Model.LatencyMsP50 != nil || m.Model.LatencyMsMax != nil || m.ContextPeakPercent != nil {
		t.Errorf("metrics = %+v, want nil times", m)
	}
}

func TestMetricsOfABranchWithoutMetricsAreNil(t *testing.T) {
	m, err := parseLines(t, entryLine("message", "a", "")).Metrics()
	if err != nil || m != nil {
		t.Errorf("Metrics() = %+v, %v; want nil, nil", m, err)
	}
}

func TestMetricsFailOnAnInvalidEntry(t *testing.T) {
	const valid = `{"version":1,"tokens":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"costUsd":0,"turns":0,` +
		`"model":{"calls":0,"ttftMsP50":null,"latencyMsP50":null,"latencyMsMax":null},"tools":{"bash":{"calls":1,"errors":0,"msP50":1,"msMax":1}},"compactions":0,` +
		`"contextPeakPercent":null,"cacheMisses":[{"turn":2,"expected":1,"cacheRead":0}],"samples":{"ttftMs":[],"latencyMs":[],"toolMs":{}}}`
	line := func(data string) string {
		return `{"type":"custom","customType":"pi-agent.metrics","id":"a","parentId":null,"timestamp":"2026-11-16T06:46:36Z","data":` + data + "}"
	}
	tests := map[string]string{
		"no version":         strings.Replace(valid, `"version":1,`, "", 1),
		"no tokens":          strings.Replace(valid, `"tokens":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},`, "", 1),
		"no cacheWrite":      strings.Replace(valid, `,"cacheWrite":0`, "", 1),
		"no peak":            strings.Replace(valid, `"contextPeakPercent":null,`, "", 1),
		"tool without msMax": strings.Replace(valid, `,"msMax":1`, "", 1),
		"miss without turn":  strings.Replace(valid, `"turn":2,`, "", 1),
		"no samples":         strings.Replace(valid, `,"samples":{"ttftMs":[],"latencyMs":[],"toolMs":{}}`, "", 1),
		"tokens wrong type":  strings.Replace(valid, `"input":0`, `"input":"0"`, 1),
		"data not object":    "[]",
	}
	for name, data := range tests {
		t.Run(name, func(t *testing.T) {
			_, err := parseLines(t, line(data)).Metrics()
			var ee *EntryError
			if !errors.As(err, &ee) {
				t.Errorf("err = %v, want an EntryError", err)
			}
		})
	}
	t.Run("valid", func(t *testing.T) {
		if _, err := parseLines(t, line(valid)).Metrics(); err != nil {
			t.Errorf("err = %v", err)
		}
	})
	t.Run("other version", func(t *testing.T) {
		_, err := parseLines(t, line(strings.Replace(valid, `"version":1`, `"version":2`, 1))).Metrics()
		var ve *UnsupportedVersionError
		if !errors.As(err, &ve) || ve.CustomType != CustomTypeMetrics {
			t.Errorf("err = %v, want UnsupportedVersionError", err)
		}
	})
}
