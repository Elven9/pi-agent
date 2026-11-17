package sessionparser

import "encoding/json"

// TypeCompaction is a compaction entry; its systemMessage is a complete prompt checkpoint.
const TypeCompaction = "compaction"

// promptSections are the system prompt's sections by name, replayed along a branch: a system
// message patches them (null removes one), a compaction checkpoint replaces them all.
type promptSections map[string]string

// apply applies e when it is a system message or a compaction checkpoint and reports whether
// it was one.
func (p promptSections) apply(e Entry) (bool, error) {
	switch e.Type {
	case TypeCompaction:
		var d struct {
			SystemMessage *struct {
				Sections json.RawMessage `json:"sections"`
			} `json:"systemMessage"`
		}
		if err := json.Unmarshal(e.Raw, &d); err != nil {
			return false, err
		}
		if d.SystemMessage == nil {
			return false, nil // older compaction entries have no checkpoint
		}
		clear(p)
		return true, p.patch(d.SystemMessage.Sections)
	case TypeMessage:
		msg, err := decodeMessage(e)
		if err != nil || msg.Role != "system" {
			return false, err
		}
		return true, p.patch(msg.Sections)
	}
	return false, nil
}

func (p promptSections) patch(sections json.RawMessage) error {
	if nullToNil(sections) == nil {
		return nil
	}
	var m map[string]*string
	if err := json.Unmarshal(sections, &m); err != nil {
		return err
	}
	for name, text := range m {
		if text == nil {
			delete(p, name)
		} else {
			p[name] = *text
		}
	}
	return nil
}
