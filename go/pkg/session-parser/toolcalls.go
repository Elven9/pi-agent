package sessionparser

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ToolCall is a tool call the model made, with its result when there is one.
type ToolCall struct {
	// ID is the call id the result refers to (toolCallId).
	ID   string
	Name string
	// Args is the arguments object as the model sent it.
	Args json.RawMessage
	// ArgsError is set when the model's arguments were not a valid JSON object (Args is {}).
	ArgsError *string
	// EntryID is the assistant message entry that made the call.
	EntryID  string
	CalledAt time.Time
	// Ref is the tool-ref handle ([tool-ref #N]) of the result; nil without one (session
	// without the tool-ref extension, or no result).
	Ref *int
	// Result is nil when the branch has no result for the call (e.g. pi stopped mid-call).
	Result *ToolResult
	// Nested are the calls a codemode script made, in the order it made them; nil for other
	// tools and for a codemode call without result or nested calls.
	Nested []NestedCall
}

// ToolResult is the toolResult message of a call.
type ToolResult struct {
	// EntryID is the toolResult message entry.
	EntryID string
	IsError bool
	// Content is the result's content blocks, without the tool-ref trailer.
	Content []ContentBlock
	// Details is the tool's structured details; nil when it has none.
	Details json.RawMessage
	At      time.Time
	// DurationMs is how long the tool ran; nil in results from older pi versions.
	DurationMs *float64
}

// ContentBlock is a text or image block of a tool result.
type ContentBlock struct {
	// Type is "text" or "image".
	Type string `json:"type"`
	// Text is the text of a text block.
	Text *string `json:"text,omitempty"`
	// MimeType and Data (base64) are an image block's.
	MimeType *string `json:"mimeType,omitempty"`
	Data     *string `json:"data,omitempty"`
}

// Text is the result's text blocks joined with newlines (images left out).
func (r *ToolResult) Text() string {
	var parts []string
	for _, b := range r.Content {
		if b.Type == "text" && b.Text != nil {
			parts = append(parts, *b.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// trailer is a text block that is exactly a tool-ref handle (src/shared/tool-ref.ts).
var trailer = regexp.MustCompile(`^\[tool-ref #(\d+)\]$`)

// ToolCalls returns the tool calls on the current branch in the order the model made them,
// each with its result. An invalid assistant or toolResult message, a duplicate call id, or a
// result without its call earlier on the branch is an [*EntryError].
func (s *Session) ToolCalls() ([]ToolCall, error) {
	var calls []ToolCall
	byID := map[string]int{}
	for _, e := range s.Branch() {
		if e.Type != TypeMessage {
			continue
		}
		var err error
		switch msg, merr := decodeMessage(e); {
		case merr != nil:
			err = merr
		case msg.Role == "assistant":
			calls, err = appendCalls(calls, byID, e, msg)
		case msg.Role == "toolResult":
			err = attachResult(calls, byID, e, msg)
		}
		if err != nil {
			return nil, e.invalid(err)
		}
	}
	return calls, nil
}

// message is the part of pi's AgentMessage that tool calls need.
type message struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	ToolCallID string          `json:"toolCallId"`
	ToolName   string          `json:"toolName"`
	IsError    *bool           `json:"isError"`
	Details    json.RawMessage `json:"details"`
	DurationMs *float64        `json:"durationMs"`
	// Sections are a system message's prompt sections.
	Sections json.RawMessage `json:"sections"`
}

func decodeMessage(e Entry) (message, error) {
	var m message
	if err := e.decodeField("message", &m); err != nil {
		return message{}, err
	}
	if m.Role == "" {
		return message{}, missing("message.role")
	}
	return m, nil
}

func appendCalls(calls []ToolCall, byID map[string]int, e Entry, msg message) ([]ToolCall, error) {
	var blocks []struct {
		Type           string          `json:"type"`
		ID             string          `json:"id"`
		Name           string          `json:"name"`
		Arguments      json.RawMessage `json:"arguments"`
		ArgumentsError *string         `json:"argumentsError"`
	}
	if err := json.Unmarshal(msg.Content, &blocks); err != nil {
		return nil, fmt.Errorf("message.content: %w", err)
	}
	for _, b := range blocks {
		if b.Type != "toolCall" {
			continue
		}
		if b.ID == "" || b.Name == "" {
			return nil, errors.New("toolCall without id or name")
		}
		if len(b.Arguments) == 0 || b.Arguments[0] != '{' {
			return nil, fmt.Errorf("toolCall %q: arguments is not an object", b.ID)
		}
		if _, dup := byID[b.ID]; dup {
			return nil, fmt.Errorf("duplicate toolCall id %q", b.ID)
		}
		byID[b.ID] = len(calls)
		calls = append(calls, ToolCall{
			ID: b.ID, Name: b.Name, Args: b.Arguments, ArgsError: b.ArgumentsError,
			EntryID: e.ID, CalledAt: e.Timestamp,
		})
	}
	return calls, nil
}

func attachResult(calls []ToolCall, byID map[string]int, e Entry, msg message) error {
	i, ok := byID[msg.ToolCallID]
	switch {
	case msg.ToolCallID == "":
		return missing("message.toolCallId")
	case !ok:
		return fmt.Errorf("toolResult for %q: no such call earlier on the branch", msg.ToolCallID)
	case calls[i].Result != nil:
		return fmt.Errorf("second toolResult for %q", msg.ToolCallID)
	case msg.ToolName != calls[i].Name:
		return fmt.Errorf("toolResult for %q names tool %q, the call %q", msg.ToolCallID, msg.ToolName, calls[i].Name)
	case msg.IsError == nil:
		return missing("message.isError")
	}
	var content []ContentBlock
	if err := json.Unmarshal(msg.Content, &content); err != nil || content == nil {
		return fmt.Errorf("message.content is not a list of blocks: %v", err)
	}
	for _, b := range content {
		if b.Type == "" || (b.Type == "text" && b.Text == nil) {
			return errors.New("message.content has a block without type or text")
		}
	}
	ref, content, err := splitTrailer(content)
	if err != nil {
		return err
	}
	if calls[i].Name == ToolCodemode {
		if calls[i].Nested, err = nestedCalls(nullToNil(msg.Details)); err != nil {
			return err
		}
	}
	calls[i].Ref = ref
	calls[i].Result = &ToolResult{
		EntryID: e.ID, IsError: *msg.IsError, Content: content,
		Details: nullToNil(msg.Details), At: e.Timestamp, DurationMs: msg.DurationMs,
	}
	return nil
}

// splitTrailer removes the tool-ref trailer: the last text block that is exactly a handle.
func splitTrailer(content []ContentBlock) (*int, []ContentBlock, error) {
	for i := len(content) - 1; i >= 0; i-- {
		b := content[i]
		if b.Type != "text" {
			continue
		}
		m := trailer.FindStringSubmatch(*b.Text)
		if m == nil {
			continue
		}
		n, err := strconv.Atoi(m[1])
		if err != nil {
			return nil, nil, fmt.Errorf("tool-ref handle %q: %w", m[1], err)
		}
		return &n, append(content[:i:i], content[i+1:]...), nil
	}
	return nil, content, nil
}

func nullToNil(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	return raw
}
