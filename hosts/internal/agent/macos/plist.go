package macos

import (
	"bytes"
	"encoding/base64"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// ParsePlist decodes an XML property list (the form `plutil -convert xml1`
// and `diskutil … -plist` print) into Go values: map[string]any for dict,
// []any for array, string, int64 for integer, float64 for real, bool,
// time.Time for date and []byte for data.
func ParsePlist(b []byte) (any, error) {
	d := xml.NewDecoder(bytes.NewReader(b))
	d.Strict = false
	for {
		tok, err := d.Token()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil, errors.New("plist: no value")
			}
			return nil, fmt.Errorf("plist: %w", err)
		}
		se, ok := tok.(xml.StartElement)
		if !ok || se.Name.Local == "plist" {
			continue
		}
		return plistValue(d, se, 0)
	}
}

// maxPlistDepth bounds nesting (the property lists the agent reads are
// a few levels deep).
const maxPlistDepth = 32

func plistValue(d *xml.Decoder, se xml.StartElement, depth int) (any, error) {
	if depth > maxPlistDepth {
		return nil, errors.New("plist: nested too deep")
	}
	switch se.Name.Local {
	case "dict":
		m := map[string]any{}
		key := ""
		for {
			tok, err := d.Token()
			if err != nil {
				return nil, fmt.Errorf("plist: %w", err)
			}
			switch t := tok.(type) {
			case xml.EndElement:
				return m, nil
			case xml.StartElement:
				if t.Name.Local == "key" {
					s, err := plistText(d)
					if err != nil {
						return nil, err
					}
					key = s
					continue
				}
				v, err := plistValue(d, t, depth+1)
				if err != nil {
					return nil, err
				}
				m[key] = v
			}
		}
	case "array":
		out := []any{}
		for {
			tok, err := d.Token()
			if err != nil {
				return nil, fmt.Errorf("plist: %w", err)
			}
			switch t := tok.(type) {
			case xml.EndElement:
				return out, nil
			case xml.StartElement:
				v, err := plistValue(d, t, depth+1)
				if err != nil {
					return nil, err
				}
				out = append(out, v)
			}
		}
	case "true", "false":
		if err := d.Skip(); err != nil {
			return nil, fmt.Errorf("plist: %w", err)
		}
		return se.Name.Local == "true", nil
	}
	s, err := plistText(d)
	if err != nil {
		return nil, err
	}
	switch se.Name.Local {
	case "string":
		return s, nil
	case "integer":
		s = strings.TrimSpace(s)
		if n, err := strconv.ParseInt(s, 10, 64); err == nil {
			return n, nil
		}
		if n, err := strconv.ParseUint(s, 10, 64); err == nil {
			return int64(min(n, uint64(1<<63-1))), nil
		}
		return nil, fmt.Errorf("plist: integer %q", s)
	case "real":
		f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
		if err != nil {
			return nil, fmt.Errorf("plist: real %q", s)
		}
		return f, nil
	case "date":
		t, err := time.Parse(time.RFC3339, strings.TrimSpace(s))
		if err != nil {
			return nil, fmt.Errorf("plist: date %q", s)
		}
		return t, nil
	case "data":
		b, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(s), ""))
		if err != nil {
			return nil, fmt.Errorf("plist: data: %w", err)
		}
		return b, nil
	}
	return s, nil
}

// plistText reads an element's character data up to its end.
func plistText(d *xml.Decoder) (string, error) {
	var b strings.Builder
	for {
		tok, err := d.Token()
		if err != nil {
			return "", fmt.Errorf("plist: %w", err)
		}
		switch t := tok.(type) {
		case xml.CharData:
			b.Write(t)
		case xml.EndElement:
			return b.String(), nil
		case xml.StartElement:
			if err := d.Skip(); err != nil {
				return "", fmt.Errorf("plist: %w", err)
			}
		}
	}
}

// dict is a decoded plist dictionary with typed getters.
type dict map[string]any

func asDict(v any) dict {
	m, _ := v.(map[string]any)
	return m
}

func (d dict) str(k string) string {
	s, _ := d[k].(string)
	return s
}

func (d dict) int(k string) (int64, bool) {
	n, ok := d[k].(int64)
	return n, ok
}

func (d dict) bool(k string) (bool, bool) {
	b, ok := d[k].(bool)
	return b, ok
}

func (d dict) time(k string) time.Time {
	t, _ := d[k].(time.Time)
	return t
}

func (d dict) dict(k string) dict { return asDict(d[k]) }

func (d dict) list(k string) []any {
	l, _ := d[k].([]any)
	return l
}

func (d dict) strings(k string) []string {
	var out []string
	for _, v := range d.list(k) {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
