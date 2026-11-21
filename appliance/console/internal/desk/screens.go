package desk

// The screen of widgets (contracts 3.6; Whombat docs/decisions/desk-display.md, “Screens of widgets”): the runtime sends the box's
// grid in `glance.grid` and each monitor's in `glance.outputs`, the page asks for the pictures the widgets name
// (`DESK_PATHS.image`) and says which outputs it shows on and how big they are (`DESK_PATHS.size`).
//
// The grid is opaque to the cross-language contracts (DeskGridWire): the runtime checks it against core's DeskGrid
// before it sends it, and the page reads it as one and draws only what it understands. The console still keeps every
// string in it to plain text, as it does every desk word. The two requests are checked against their generated
// schemas before they go.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"unicode"

	"github.com/CybexBV/whombat/appliance/console/internal/screen"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// The paths (DESK_PATHS.image, DESK_PATHS.size).
const (
	PathImage = local.DeskPathImage
	PathSize  = local.DeskPathSize
)

const (
	// MaxImageBytes is DESK_IMAGE_MAX_BYTES (desk-socket.ts; no Go constant, a test checks the copy): the largest
	// picture `image` answers.
	MaxImageBytes = 3 * 1024 * 1024
	// maxOutputName bounds a monitor's name (its EDID's), as DeskOutputGrid and DeskSizeRequest do.
	maxOutputName = 60
)

// cleanScreens cleans the box's grid and the monitors' (in cleanState). A grid that isn't an object goes, and a
// monitor without a grid goes with it.
func cleanScreens(g *Glance) {
	g.Grid = cleanGrid(g.Grid)
	outputs := g.Outputs[:0]
	for _, o := range g.Outputs {
		o.Grid = cleanGrid(o.Grid)
		o.Name = optLine(o.Name, maxOutputName)
		if o.Grid != nil {
			outputs = append(outputs, o)
		}
	}
	g.Outputs = outputs
	if len(outputs) == 0 {
		g.Outputs = nil
	}
}

// cleanGrid is a grid as the page gets it: the same JSON with every string (and every member's name) plain text
// (control and format characters gone, line breaks and tabs as spaces), nothing else changed; nil when it isn't an
// object.
func cleanGrid(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v map[string]any
	if err := dec.Decode(&v); err != nil || v == nil {
		return nil
	}
	var out bytes.Buffer
	enc := json.NewEncoder(&out)
	// Never longer than it came: `<` stays `<`, the page draws text as text.
	enc.SetEscapeHTML(false)
	if err := enc.Encode(cleanJSON(v)); err != nil {
		return nil
	}
	return bytes.TrimRight(out.Bytes(), "\n")
}

func cleanJSON(v any) any {
	switch t := v.(type) {
	case string:
		return plain(t)
	case []any:
		for i := range t {
			t[i] = cleanJSON(t[i])
		}
		return t
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, x := range t {
			// A member whose name isn't plain text isn't one the page knows.
			if plain(k) == k {
				out[k] = cleanJSON(x)
			}
		}
		return out
	}
	return v
}

// plain is s without control and format characters, its line breaks and tabs spaces; not trimmed (refs and keys pass
// exactly as sent).
func plain(s string) string {
	return screen.CleanName(strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		return r
	}, s))
}

// ImageRequest is DeskImageRequest: the thing and the signed ref a widget's view names.
type ImageRequest = local.DeskImageRequest

// ImageRequestFor checks what the page sent: a thing and a ref the socket takes (the schema,
// DESK_REQUEST_MAX_BYTES), else 400 without asking.
func ImageRequestFor(thing, ref string) (*ImageRequest, error) {
	req := &ImageRequest{V: 1, Thing: thing, Ref: ref}
	if !fits(req) {
		return nil, &Error{Status: http.StatusBadRequest, Code: local.DeskErrorBadRequest}
	}
	return req, nil
}

// fits reports whether a request is one the socket takes: its schema and DESK_REQUEST_MAX_BYTES.
func fits(req interface{ Validate() error }) bool {
	if req.Validate() != nil {
		return false
	}
	b, err := json.Marshal(req)
	return err == nil && len(b) <= local.DeskRequestMaxBytes
}

// Image is a picture one of the box's widgets names, and its type (`image/jpeg`, `image/png` or `image/webp`). The
// runtime decides whether the screen may show it (every refusal its `not_found`); the bytes must be a picture of the
// type it says, at most MaxImageBytes, else 502 `failed`.
func (c *Client) Image(ctx context.Context, thing, ref string) ([]byte, string, error) {
	req, err := ImageRequestFor(thing, ref)
	if err != nil {
		return nil, "", err
	}
	ctx, cancel := context.WithTimeout(ctx, c.callTimeout)
	defer cancel()
	body, ct, err := c.do(ctx, http.MethodPost, PathImage, req, MaxImageBytes)
	if err != nil {
		return nil, "", err
	}
	mt, _, _ := strings.Cut(ct, ";")
	kind := imageType(body)
	if kind == "" || strings.ToLower(strings.TrimSpace(mt)) != kind {
		return nil, "", &Error{Status: http.StatusBadGateway, Code: "failed"}
	}
	return body, kind, nil
}

// imageType is the type the bytes start with, of the three a picture may be; "" for anything else.
func imageType(b []byte) string {
	switch {
	case len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF:
		return "image/jpeg"
	case len(b) >= 8 && string(b[:8]) == "\x89PNG\r\n\x1a\n":
		return "image/png"
	case len(b) >= 12 && string(b[0:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return "image/webp"
	}
	return ""
}

// ScreenSize is DeskScreenSize: an output's size in logical pixels.
type ScreenSize = local.DeskSizeRequestOutputsItemSize

// SizeOutput is one output of DeskSizeRequest: its key (the compositor's name, lower case), whether it is the main
// one (the box's own display, or the only one), the monitor's name when the compositor knows it, and its size.
type SizeOutput = local.DeskSizeRequestOutputsItem

// SizeRequest is DeskSizeRequest.
type SizeRequest = local.DeskSizeRequest

// SizeRequestFor checks the outputs the page reports and builds the runtime's request: the schema (one to four, the
// keys, the sides' bounds) and DESK_REQUEST_MAX_BYTES, and the main one first and only that one main, each key once; a
// name is cleaned to one line of at most 60 first (any space a plain one; empty is none). Anything else is 400 without
// asking.
func SizeRequestFor(outputs []SizeOutput) (*SizeRequest, error) {
	bad := &Error{Status: http.StatusBadRequest, Code: local.DeskErrorBadRequest}
	if len(outputs) < 1 || !outputs[0].Main {
		return nil, bad
	}
	req := &SizeRequest{V: 1, Outputs: make([]SizeOutput, 0, len(outputs))}
	seen := map[string]bool{}
	for i, o := range outputs {
		if seen[o.Key] || (i > 0 && o.Main) {
			return nil, bad
		}
		seen[o.Key] = true
		if o.Name != nil {
			n := strings.Map(func(r rune) rune {
				if unicode.Is(unicode.Zs, r) {
					return ' '
				}
				return r
			}, *o.Name)
			o.Name = optLine(&n, maxOutputName)
		}
		req.Outputs = append(req.Outputs, o)
	}
	if !fits(req) {
		return nil, bad
	}
	return req, nil
}

// Size tells the runtime which outputs the page shows on and how big they are (at start and whenever they change):
// a second output is a monitor on the box, a screen of its own. The state is asked again after it.
func (c *Client) Size(ctx context.Context, outputs []SizeOutput) (*Ack, error) {
	req, err := SizeRequestFor(outputs)
	if err != nil {
		return nil, err
	}
	defer c.Invalidate()
	return post(c, ctx, PathSize, req, c.callTimeout, local.ParseDeskAck)
}
