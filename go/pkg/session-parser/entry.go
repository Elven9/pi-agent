package sessionparser

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// pi's entry types.
const (
	// TypeSession is the header's type.
	TypeSession = "session"
	// TypeMessage is a conversation message (user, assistant, tool result, ...).
	TypeMessage = "message"
	// TypeModelChange records a switch of model.
	TypeModelChange = "model_change"
	// TypeSessionInfo holds the session's display name.
	TypeSessionInfo = "session_info"
	// TypeCustom is an extension's entry, never model context; its payload is "data".
	TypeCustom = "custom"
	// TypeCustomMessage is an extension's message, sent to the model; its payload is "details".
	TypeCustomMessage = "custom_message"
)

// pi-agent's custom types (src/shared/protocol.ts, src/subagent/protocol.ts).
const (
	// CustomTypeSessionVersion: the pi-agent release that wrote the entries after it.
	CustomTypeSessionVersion = "pi-agent.session-version"
	// CustomTypeTags: the session's tags; the last one in the file wins.
	CustomTypeTags = "pi-agent.tags"
	// CustomTypeError: an extension could not run and pi shut down.
	CustomTypeError = "pi-agent.error"
	// CustomTypeMetrics: session metrics, cumulative along the branch.
	CustomTypeMetrics = "pi-agent.metrics"
	// CustomTypeSubagentStart: a subagent was started.
	CustomTypeSubagentStart = "subagent-start"
	// CustomTypeSubagentEnd: a subagent result recorded at session end, not yet delivered.
	CustomTypeSubagentEnd = "subagent-end"
	// CustomTypeSubagentResult: a subagent result delivered to the model (custom_message).
	CustomTypeSubagentResult = "subagent-result"
)

// EntryError is an entry whose content is invalid for its type.
type EntryError struct {
	ID         string
	Type       string
	CustomType string
	Err        error
}

func (e *EntryError) Error() string {
	kind := e.Type
	if e.CustomType != "" {
		kind += " " + e.CustomType
	}
	return fmt.Sprintf("entry %q (%s): %v", e.ID, kind, e.Err)
}

func (e *EntryError) Unwrap() error { return e.Err }

// UnsupportedVersionError is a pi-agent entry whose payload version this package does not read.
type UnsupportedVersionError struct {
	CustomType string
	Version    int
	Supported  int
}

func (e *UnsupportedVersionError) Error() string {
	return fmt.Sprintf("%s version %d is not supported (want %d)", e.CustomType, e.Version, e.Supported)
}

func (e Entry) isCustom(customType string) bool {
	return e.Type == TypeCustom && e.CustomType == customType
}

func (e Entry) isCustomMessage(customType string) bool {
	return e.Type == TypeCustomMessage && e.CustomType == customType
}

// invalid wraps err as an [*EntryError] of e.
func (e Entry) invalid(err error) error {
	return &EntryError{ID: e.ID, Type: e.Type, CustomType: e.CustomType, Err: err}
}

// decodeField decodes the entry's top-level field name into v; missing or null is an error.
func (e Entry) decodeField(name string, v any) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(e.Raw, &fields); err != nil {
		return err
	}
	raw, ok := fields[name]
	if !ok || bytes.Equal(raw, []byte("null")) {
		return missing(name)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

func missing(field string) error { return fmt.Errorf("missing %s", field) }

// checkVersion checks a versioned pi-agent payload.
func checkVersion(customType string, version *int, supported int) error {
	if version == nil {
		return missing("version")
	}
	if *version != supported {
		return &UnsupportedVersionError{CustomType: customType, Version: *version, Supported: supported}
	}
	return nil
}
