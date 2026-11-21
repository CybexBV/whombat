// Package canonjson implements RFC 8785 JSON Canonicalization Scheme (JCS) for the value shapes the
// appliance signs: objects, arrays, strings, booleans, null and integers in the IEEE-754 safe range.
//
// It mirrors `canonicalJson` in @whombat/core (packages/core/src/audit/canonical.ts): members sorted by
// UTF-16 code units, strings escaped exactly like ECMAScript JSON.stringify, no whitespace, invalid
// Unicode rejected (conservatively including U+FFFD, which Go's decoder substitutes for lone surrogates). Non-integer numbers are rejected on purpose (MG-04): no signed appliance document
// needs them and ECMAScript number formatting is a classic source of cross-language mismatches.
package canonjson

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

// MaxSafeInteger is 2^53-1, the largest integer JSON numbers carry exactly across languages.
const MaxSafeInteger = 1<<53 - 1

// Marshal encodes v with encoding/json and returns its canonical form.
func Marshal(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return Canonicalize(raw)
}

// Canonicalize returns the canonical form of a JSON document. Duplicate object keys are rejected.
func Canonicalize(doc []byte) ([]byte, error) {
	if !utf8.Valid(doc) {
		return nil, errors.New("canonjson: invalid UTF-8")
	}
	dec := json.NewDecoder(bytes.NewReader(doc))
	dec.UseNumber()
	v, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("canonjson: trailing data")
	}
	var buf bytes.Buffer
	if err := encode(&buf, v, "$"); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// IsCanonical reports whether doc is byte-for-byte canonical.
func IsCanonical(doc []byte) bool {
	c, err := Canonicalize(doc)
	return err == nil && bytes.Equal(c, doc)
}

type object struct {
	keys []string
	vals map[string]any
}

func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, fmt.Errorf("canonjson: %w", err)
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			o := &object{vals: map[string]any{}}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, fmt.Errorf("canonjson: %w", err)
				}
				k, ok := kt.(string)
				if !ok {
					return nil, errors.New("canonjson: object key is not a string")
				}
				if _, dup := o.vals[k]; dup {
					return nil, fmt.Errorf("canonjson: duplicate key %q", k)
				}
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				o.keys = append(o.keys, k)
				o.vals[k] = v
			}
			if _, err := dec.Token(); err != nil {
				return nil, fmt.Errorf("canonjson: %w", err)
			}
			return o, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, fmt.Errorf("canonjson: %w", err)
			}
			return arr, nil
		}
		return nil, fmt.Errorf("canonjson: unexpected delimiter %v", t)
	default:
		return tok, nil
	}
}

func encode(buf *bytes.Buffer, v any, path string) error {
	switch t := v.(type) {
	case nil:
		buf.WriteString("null")
	case bool:
		if t {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case json.Number:
		s, err := canonicalNumber(t)
		if err != nil {
			return fmt.Errorf("canonjson: %s at %s", err, path)
		}
		buf.WriteString(s)
	case string:
		return encodeString(buf, t, path)
	case []any:
		buf.WriteByte('[')
		for i, item := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := encode(buf, item, fmt.Sprintf("%s[%d]", path, i)); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	case *object:
		keys := append([]string(nil), t.keys...)
		sort.Slice(keys, func(i, j int) bool { return lessUTF16(keys[i], keys[j]) })
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := encodeString(buf, k, path); err != nil {
				return err
			}
			buf.WriteByte(':')
			if err := encode(buf, t.vals[k], path+"."+k); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	default:
		return fmt.Errorf("canonjson: unsupported value %T at %s", v, path)
	}
	return nil
}

func canonicalNumber(n json.Number) (string, error) {
	if i, err := strconv.ParseInt(string(n), 10, 64); err == nil {
		if i > MaxSafeInteger || i < -MaxSafeInteger {
			return "", errors.New("integer outside the safe range")
		}
		return strconv.FormatInt(i, 10), nil
	}
	f, err := strconv.ParseFloat(string(n), 64)
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
		return "", errors.New("invalid number")
	}
	if f != math.Trunc(f) || math.Abs(f) > MaxSafeInteger {
		return "", errors.New("non-integer numbers are not allowed")
	}
	if f == 0 {
		return "0", nil // -0 becomes 0, like ECMAScript
	}
	return strconv.FormatInt(int64(f), 10), nil
}

// lessUTF16 orders strings by UTF-16 code units (ECMAScript's default sort), which differs from
// byte order for characters above U+FFFF versus U+E000..U+FFFF.
func lessUTF16(a, b string) bool {
	ua := utf16.Encode([]rune(a))
	ub := utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

const hexDigits = "0123456789abcdef"

func encodeString(buf *bytes.Buffer, s string, path string) error {
	if !utf8.ValidString(s) {
		return fmt.Errorf("canonjson: invalid Unicode in string at %s", path)
	}
	buf.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			buf.WriteString(`\"`)
		case '\\':
			buf.WriteString(`\\`)
		case '\b':
			buf.WriteString(`\b`)
		case '\f':
			buf.WriteString(`\f`)
		case '\n':
			buf.WriteString(`\n`)
		case '\r':
			buf.WriteString(`\r`)
		case '\t':
			buf.WriteString(`\t`)
		default:
			if r < 0x20 {
				buf.WriteString(`\u00`)
				buf.WriteByte(hexDigits[r>>4])
				buf.WriteByte(hexDigits[r&0xf])
			} else if r == utf8.RuneError {
				return fmt.Errorf("canonjson: invalid Unicode in string at %s", path)
			} else {
				buf.WriteRune(r)
			}
		}
	}
	buf.WriteByte('"')
	return nil
}
