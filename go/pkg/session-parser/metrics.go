package sessionparser

import (
	"encoding/json"
	"fmt"
	"time"
)

// MetricsVersion is the pi-agent.metrics payload version this package reads.
const MetricsVersion = 1

// Metrics are a branch's session metrics (src/shared/metrics.ts). pi-agent.metrics entries are
// cumulative along a branch, so the totals are the newest entry's; the samples (only what was
// new at each entry) are those of every entry on the branch, oldest first.
type Metrics struct {
	Tokens  Tokens
	CostUSD float64
	// Turns are agent turns.
	Turns int
	Model ModelMetrics
	// Tools are per tool name.
	Tools       map[string]ToolMetrics
	Compactions int
	// ContextPeakPercent is the highest context use; nil when unknown.
	ContextPeakPercent *float64
	// CacheMisses are requests that read under 95% of the expected cached prefix.
	CacheMisses []CacheMiss
	Samples     Samples

	// Entries is how many metrics entries the branch has.
	Entries int
	// EntryID and At are the newest entry's.
	EntryID string
	At      time.Time
}

// Tokens are token totals.
type Tokens struct {
	Input      int `json:"input"`
	Output     int `json:"output"`
	CacheRead  int `json:"cacheRead"`
	CacheWrite int `json:"cacheWrite"`
}

// ModelMetrics are model request statistics; the times are nil when there was no request.
type ModelMetrics struct {
	Calls        int      `json:"calls"`
	TTFTMsP50    *float64 `json:"ttftMsP50"`
	LatencyMsP50 *float64 `json:"latencyMsP50"`
	LatencyMsMax *float64 `json:"latencyMsMax"`
}

// ToolMetrics are one tool's statistics.
type ToolMetrics struct {
	Calls  int     `json:"calls"`
	Errors int     `json:"errors"`
	MsP50  float64 `json:"msP50"`
	MsMax  float64 `json:"msMax"`
}

// CacheMiss is a request that read less from the prompt cache than expected.
type CacheMiss struct {
	// Turn is 1-based.
	Turn int `json:"turn"`
	// Expected is what the previous request had cached (its cacheRead + cacheWrite).
	Expected  int `json:"expected"`
	CacheRead int `json:"cacheRead"`
}

// Samples are raw measurements in milliseconds, to compute percentiles from.
type Samples struct {
	TTFTMs    []float64 `json:"ttftMs"`
	LatencyMs []float64 `json:"latencyMs"`
	// ToolMs are tool durations per tool name.
	ToolMs map[string][]float64 `json:"toolMs"`
}

// metricsEntry is a pi-agent.metrics payload.
type metricsEntry struct {
	Version            *int                   `json:"version"`
	Tokens             Tokens                 `json:"tokens"`
	CostUSD            float64                `json:"costUsd"`
	Turns              int                    `json:"turns"`
	Model              ModelMetrics           `json:"model"`
	Tools              map[string]ToolMetrics `json:"tools"`
	Compactions        int                    `json:"compactions"`
	ContextPeakPercent *float64               `json:"contextPeakPercent"`
	CacheMisses        []CacheMiss            `json:"cacheMisses"`
	Samples            Samples                `json:"samples"`
}

// Metrics reads the current branch's metrics; nil when it has no pi-agent.metrics entry. An
// invalid entry is an [*EntryError]; another payload version an [*UnsupportedVersionError].
func (s *Session) Metrics() (*Metrics, error) {
	var m *Metrics
	for _, e := range s.Branch() {
		if !e.isCustom(CustomTypeMetrics) {
			continue
		}
		d, err := decodeMetrics(e)
		if err != nil {
			return nil, e.invalid(err)
		}
		if m == nil {
			m = &Metrics{Samples: Samples{TTFTMs: []float64{}, LatencyMs: []float64{}, ToolMs: map[string][]float64{}}}
		}
		samples := m.Samples
		samples.TTFTMs = append(samples.TTFTMs, d.Samples.TTFTMs...)
		samples.LatencyMs = append(samples.LatencyMs, d.Samples.LatencyMs...)
		for name, ms := range d.Samples.ToolMs {
			samples.ToolMs[name] = append(samples.ToolMs[name], ms...)
		}
		*m = Metrics{
			Tokens: d.Tokens, CostUSD: d.CostUSD, Turns: d.Turns, Model: d.Model, Tools: d.Tools,
			Compactions: d.Compactions, ContextPeakPercent: d.ContextPeakPercent, CacheMisses: d.CacheMisses,
			Samples: samples, Entries: m.Entries + 1, EntryID: e.ID, At: e.Timestamp,
		}
	}
	return m, nil
}

func decodeMetrics(e Entry) (metricsEntry, error) {
	var raw json.RawMessage
	if err := e.decodeField("data", &raw); err != nil {
		return metricsEntry{}, err
	}
	var d metricsEntry
	if err := json.Unmarshal(raw, &d); err != nil {
		return metricsEntry{}, fmt.Errorf("data: %w", err)
	}
	if err := checkVersion(CustomTypeMetrics, d.Version, MetricsVersion); err != nil {
		return metricsEntry{}, err
	}
	if err := checkMetricsKeys(raw); err != nil {
		return metricsEntry{}, fmt.Errorf("data.%w", err)
	}
	return d, nil
}

// checkMetricsKeys checks that every field of a metrics payload is there (null where allowed).
func checkMetricsKeys(raw json.RawMessage) error {
	top, err := requireKeys(raw, "", "tokens", "costUsd", "turns", "model", "tools", "compactions", "contextPeakPercent", "cacheMisses", "samples")
	if err != nil {
		return err
	}
	if _, err := requireKeys(top["tokens"], "tokens", "input", "output", "cacheRead", "cacheWrite"); err != nil {
		return err
	}
	if _, err := requireKeys(top["model"], "model", "calls", "ttftMsP50", "latencyMsP50", "latencyMsMax"); err != nil {
		return err
	}
	if _, err := requireKeys(top["samples"], "samples", "ttftMs", "latencyMs", "toolMs"); err != nil {
		return err
	}
	var tools map[string]json.RawMessage
	if err := json.Unmarshal(top["tools"], &tools); err != nil || tools == nil {
		return fmt.Errorf("tools is not an object")
	}
	for name, t := range tools {
		if _, err := requireKeys(t, "tools."+name, "calls", "errors", "msP50", "msMax"); err != nil {
			return err
		}
	}
	var misses []json.RawMessage
	if err := json.Unmarshal(top["cacheMisses"], &misses); err != nil || misses == nil {
		return fmt.Errorf("cacheMisses is not a list")
	}
	for i, miss := range misses {
		if _, err := requireKeys(miss, fmt.Sprintf("cacheMisses[%d]", i), "turn", "expected", "cacheRead"); err != nil {
			return err
		}
	}
	return nil
}

// requireKeys checks that raw is an object with every key (null allowed) and returns its fields.
// path names raw in errors.
func requireKeys(raw json.RawMessage, path string, keys ...string) (map[string]json.RawMessage, error) {
	prefix := ""
	if path != "" {
		prefix = path + "."
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, fmt.Errorf("%s is not an object", path)
	}
	for _, k := range keys {
		if _, ok := fields[k]; !ok {
			return nil, fmt.Errorf("%smissing %s", prefix, k)
		}
	}
	return fields, nil
}
