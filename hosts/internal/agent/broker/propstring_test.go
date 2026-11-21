package broker

import (
	"reflect"
	"strings"
	"testing"
)

func TestPropString(t *testing.T) {
	p := parsePropString("local-zfs:vm-100-disk-0,iothread=1,size=32G")
	want := propString{{Value: "local-zfs:vm-100-disk-0"}, {Key: "iothread", Value: "1", HasKey: true}, {Key: "size", Value: "32G", HasKey: true}}
	if !reflect.DeepEqual(p, want) {
		t.Fatalf("parse %+v", p)
	}
	if v, n := p.Default("file", "volume"); v != "local-zfs:vm-100-disk-0" || n != 1 {
		t.Fatalf("default %q %d", v, n)
	}
	if v, ok := p.Get("size"); !ok || v != "32G" {
		t.Fatalf("size %q", v)
	}
	// Changing one key keeps the order and every other item.
	p.Set("iothread", "0")
	p.Set("discard", "on")
	if got := p.String(); got != "local-zfs:vm-100-disk-0,iothread=0,size=32G,discard=on" {
		t.Fatalf("set: %s", got)
	}
	p.Delete("size")
	if got := p.String(); got != "local-zfs:vm-100-disk-0,iothread=0,discard=on" {
		t.Fatalf("delete: %s", got)
	}

	// The default key named explicitly, or twice.
	if v, n := parsePropString("iothread=1,file=local:iso/x.iso").Default("file", "volume"); v != "local:iso/x.iso" || n != 1 {
		t.Fatalf("explicit default %q %d", v, n)
	}
	if _, n := parsePropString("a:1,volume=b:2").Default("file", "volume"); n != 2 {
		t.Fatalf("two volumes counted %d", n)
	}
	// VM network cards: the model is the key of the first item.
	nic := parsePropString("virtio=BC:24:11:AA:BB:CC,bridge=vmbr0,firewall=1")
	if nic[0].Key != "virtio" || nic[0].Value != "BC:24:11:AA:BB:CC" {
		t.Fatalf("nic %+v", nic)
	}
	// Commas inside quotes stay in the item.
	q := parsePropString(`name="a,b",x=1`)
	if len(q) != 2 || q[0].Value != `"a,b"` {
		t.Fatalf("quoted %+v", q)
	}
	if parsePropString("") != nil || parsePropString("").String() != "" {
		t.Fatal("empty")
	}
}

// FuzzPropString: every string survives parse and String unchanged, and
// changing one key changes nothing else.
func FuzzPropString(f *testing.F) {
	for _, s := range []string{
		"", ",", "=", "a", "a=", "=b", "a=b=c", ",,a,,", "local-zfs:vm-100-disk-0,iothread=1,size=32G",
		"virtio=BC:24:11:AA:BB:CC,bridge=vmbr0,tag=20", `name="a,b",x="c\"d,e"`, `"unbalanced,x=1`, "order=scsi0;ide2;net0",
		"local:iso/debian.iso,media=cdrom,size=737280K", "nesting=1,keyctl=1",
	} {
		f.Add(s, "size", "64G")
	}
	f.Fuzz(func(t *testing.T, s, key, value string) {
		p := parsePropString(s)
		if got := p.String(); got != s {
			t.Fatalf("round trip %q -> %q", s, got)
		}
		if !reflect.DeepEqual(parsePropString(p.String()), p) {
			t.Fatalf("reparse differs for %q", s)
		}
		// Set and Delete are checked on strings without quotes: an item
		// appended after an unbalanced quote would join the quoted item.
		if key == "" || strings.ContainsAny(s, `"`) || strings.ContainsAny(key, `=,"\`) || strings.ContainsAny(value, `,"\`) {
			return
		}
		before := len(p)
		_, had := p.Get(key)
		q := append(propString(nil), p...)
		q.Set(key, value)
		if v, ok := q.Get(key); !ok || v != value {
			t.Fatalf("set %s=%s on %q: got %q", key, value, s, v)
		}
		if had && len(q) != before || !had && len(q) != before+1 {
			t.Fatalf("set changed the item count of %q", s)
		}
		// Every other item is unchanged and in order.
		var others, othersAfter []propItem
		for _, it := range p {
			if !it.HasKey || it.Key != key {
				others = append(others, it)
			}
		}
		for _, it := range q {
			if !it.HasKey || it.Key != key {
				othersAfter = append(othersAfter, it)
			}
		}
		if !reflect.DeepEqual(others, othersAfter) {
			t.Fatalf("set %s on %q changed other items", key, s)
		}
		if got := parsePropString(q.String()); !reflect.DeepEqual(got, q) {
			t.Fatalf("set %s=%s on %q does not round-trip: %q", key, value, s, q.String())
		}
		q.Delete(key)
		if _, ok := q.Get(key); ok || q.String() != propString(others).String() {
			t.Fatalf("delete %s on %q", key, s)
		}
	})
}
