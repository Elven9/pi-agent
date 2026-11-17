package sessionparser

import (
	"encoding/json"
	"errors"
	"fmt"
)

// ToolCodemode is the name of pi's codemode tool: the model writes a script that calls other
// tools.
const ToolCodemode = "codemode"

// Nested call statuses (pi's CodemodeNestedCallStatus).
const (
	NestedOK        = "ok"
	NestedError     = "error"
	NestedCancelled = "cancelled"
	// NestedRunning is left in results pi wrote while the script was still running.
	NestedRunning = "running"
)

// NestedCall is a tool call a codemode script made, from the details of the codemode result.
// pi keeps only a preview of it: the arguments cut to 200 characters and no result; the
// session has no toolResult entry for it.
type NestedCall struct {
	// ID is "<codemode call id>/<n>".
	ID   string
	Name string
	// ArgsPreview is the compact JSON of the arguments as pi recorded it; pi cuts it to 200
	// characters ending in "...".
	ArgsPreview string
	// Args is ArgsPreview as an object; nil when the preview was cut and is not valid JSON.
	Args json.RawMessage
	// Status is one of NestedOK, NestedError, NestedCancelled, NestedRunning.
	Status     string
	DurationMs *float64
	// Error is the start of the error text of a failed call.
	Error *string
	// CostUSD is the cost of a models.* call (classifier, image) that reported usage.
	CostUSD *float64
}

// nestedCalls reads the nested calls of a codemode result's details. Details without "calls"
// (e.g. pi rejected the script before it ran) give nil.
func nestedCalls(details json.RawMessage) ([]NestedCall, error) {
	if details == nil {
		return nil, nil
	}
	var d struct {
		Calls []struct {
			ID         string   `json:"id"`
			Name       string   `json:"name"`
			Args       *string  `json:"args"`
			Status     string   `json:"status"`
			DurationMs *float64 `json:"durationMs"`
			Error      *string  `json:"error"`
			Cost       *float64 `json:"cost"`
		} `json:"calls"`
	}
	if err := json.Unmarshal(details, &d); err != nil {
		return nil, fmt.Errorf("codemode details: %w", err)
	}
	var calls []NestedCall
	for _, c := range d.Calls {
		switch {
		case c.ID == "" || c.Name == "":
			return nil, errors.New("codemode nested call without id or name")
		case c.Args == nil:
			return nil, fmt.Errorf("codemode nested call %q: %w", c.ID, missing("args"))
		}
		switch c.Status {
		case NestedOK, NestedError, NestedCancelled, NestedRunning:
		default:
			return nil, fmt.Errorf("codemode nested call %q: status %q is not ok, error, cancelled or running", c.ID, c.Status)
		}
		var args json.RawMessage
		if json.Valid([]byte(*c.Args)) && len(*c.Args) > 0 && (*c.Args)[0] == '{' {
			args = json.RawMessage(*c.Args)
		}
		calls = append(calls, NestedCall{
			ID: c.ID, Name: c.Name, ArgsPreview: *c.Args, Args: args, Status: c.Status,
			DurationMs: c.DurationMs, Error: c.Error, CostUSD: c.Cost,
		})
	}
	return calls, nil
}
