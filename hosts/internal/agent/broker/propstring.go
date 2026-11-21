package broker

import (
	"slices"
	"strings"
)

// propString is a Proxmox VE property string ("local-zfs:vm-100-disk-0,
// iothread=1,size=32G"): an ordered list of items separated by commas.
// An item "key=value" names its key; an item without "=" is the value of
// the format's default key (the volume of a disk). Commas inside double
// quotes do not separate items.
//
// Parsing keeps every item as written, so String() returns the input
// unchanged, and changing one key keeps the order and every other item
// (unknown sub-options survive a round trip through Whombat).
type propString []propItem

// propItem is one item. HasKey is false for a default-key item ("virtio"
// or "local:iso/x.iso"); Key is "" then.
type propItem struct {
	Key, Value string
	HasKey     bool
}

func parsePropString(s string) propString {
	if s == "" {
		return nil
	}
	var p propString
	start, quoted := 0, false
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '\\':
			if quoted {
				i++ // escaped character inside quotes
			}
		case '"':
			quoted = !quoted
		case ',':
			if !quoted {
				p = append(p, parsePropItem(s[start:i]))
				start = i + 1
			}
		}
	}
	return append(p, parsePropItem(s[start:]))
}

func parsePropItem(s string) propItem {
	if k, v, ok := strings.Cut(s, "="); ok {
		return propItem{Key: k, Value: v, HasKey: true}
	}
	return propItem{Value: s}
}

func (p propString) String() string {
	var b strings.Builder
	for i, it := range p {
		if i > 0 {
			b.WriteByte(',')
		}
		if it.HasKey {
			b.WriteString(it.Key)
			b.WriteByte('=')
		}
		b.WriteString(it.Value)
	}
	return b.String()
}

// Get returns the value of the first item with this key.
func (p propString) Get(key string) (string, bool) {
	for _, it := range p {
		if it.HasKey && it.Key == key {
			return it.Value, true
		}
	}
	return "", false
}

// Default returns the default key's value: the first item without "=" or
// an item naming one of the keys (the default key and its aliases, e.g.
// "file" and "volume" for VM disks). n counts such items; PVE refuses
// more than one.
func (p propString) Default(keys ...string) (value string, n int) {
	for _, it := range p {
		if !it.HasKey || slices.Contains(keys, it.Key) {
			if n == 0 {
				value = it.Value
			}
			n++
		}
	}
	return value, n
}

// Set changes the first item with this key in place, or appends one.
func (p *propString) Set(key, value string) {
	for i, it := range *p {
		if it.HasKey && it.Key == key {
			(*p)[i].Value = value
			return
		}
	}
	*p = append(*p, propItem{Key: key, Value: value, HasKey: true})
}

// Delete removes every item with this key.
func (p *propString) Delete(key string) {
	out := (*p)[:0]
	for _, it := range *p {
		if !it.HasKey || it.Key != key {
			out = append(out, it)
		}
	}
	*p = out
}
