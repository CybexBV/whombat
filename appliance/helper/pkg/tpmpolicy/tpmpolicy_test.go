package tpmpolicy

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

type sec struct {
	name string
	data []byte
	vs   uint32 // virtual size (0 = len(data))
}

// buildPE writes a minimal PE32+ image with the given sections (file alignment 512, raw data padded).
func buildPE(t *testing.T, path string, secs []sec) {
	t.Helper()
	var b bytes.Buffer
	dos := make([]byte, 64)
	dos[0], dos[1] = 'M', 'Z'
	binary.LittleEndian.PutUint32(dos[60:], 64)
	b.Write(dos)
	b.WriteString("PE\x00\x00")
	optSize := 240
	coff := make([]byte, 20)
	binary.LittleEndian.PutUint16(coff[0:], 0x8664)
	binary.LittleEndian.PutUint16(coff[2:], uint16(len(secs)))
	binary.LittleEndian.PutUint16(coff[16:], uint16(optSize))
	binary.LittleEndian.PutUint16(coff[18:], 0x0022)
	b.Write(coff)
	opt := make([]byte, optSize)
	binary.LittleEndian.PutUint16(opt[0:], 0x20b)
	binary.LittleEndian.PutUint32(opt[32:], 0x1000) // section alignment
	binary.LittleEndian.PutUint32(opt[36:], 0x200)  // file alignment
	binary.LittleEndian.PutUint32(opt[108:], 16)    // number of data directories
	b.Write(opt)
	headerEnd := b.Len() + 40*len(secs)
	off := (headerEnd + 0x1ff) &^ 0x1ff
	va := uint32(0x1000)
	var body bytes.Buffer
	for _, s := range secs {
		raw := len(s.data)
		rawAligned := (raw + 0x1ff) &^ 0x1ff
		vs := s.vs
		if vs == 0 {
			vs = uint32(raw)
		}
		h := make([]byte, 40)
		copy(h, s.name)
		binary.LittleEndian.PutUint32(h[8:], vs)
		binary.LittleEndian.PutUint32(h[12:], va)
		binary.LittleEndian.PutUint32(h[16:], uint32(rawAligned))
		binary.LittleEndian.PutUint32(h[20:], uint32(off+body.Len()))
		binary.LittleEndian.PutUint32(h[36:], 0x40000040)
		b.Write(h)
		body.Write(s.data)
		body.Write(make([]byte, rawAligned-raw))
		va += (vs + 0xfff) &^ 0xfff
	}
	b.Write(make([]byte, off-b.Len()))
	b.Write(body.Bytes())
	if err := os.WriteFile(path, b.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func sum(b []byte) []byte { h := sha256.Sum256(b); return h[:] }

func TestThinStubMeasureArgs(t *testing.T) {
	esp := t.TempDir()
	kernel, initrd := []byte("kernel image bytes"), []byte("initrd bytes")
	if err := os.MkdirAll(filepath.Join(esp, "EFI", "nixos"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(esp, "EFI", "nixos", "kernel-x.efi"), kernel, 0o644)
	_ = os.WriteFile(filepath.Join(esp, "EFI", "nixos", "initrd-x.efi"), initrd, 0o644)
	_ = os.MkdirAll(filepath.Join(esp, "EFI", "Linux"), 0o755)
	stub := filepath.Join(esp, "EFI", "Linux", "nixos-generation-3-abc+2-1.efi")
	buildPE(t, stub, []sec{
		{name: ".text", data: []byte{0xc3}},
		{name: ".osrel", data: []byte("ID=nixos\n")},
		{name: ".cmdline", data: []byte("init=/nix/store/x/init quiet")},
		{name: ".initrd", data: []byte(`\EFI\nixos\initrd-x.efi`)},
		{name: ".linux", data: []byte(`\EFI\nixos\kernel-x.efi` + "\x00")},
		{name: ".initrdh", data: sum(initrd)},
		{name: ".linuxh", data: sum(kernel)},
		// VirtualSize larger than the data: the stub measures zero padding up to VirtualSize.
		{name: ".sbat", data: []byte("sbat,1\n"), vs: 10},
	})
	// The recovery UKI in the same directory is never a signing candidate.
	buildPE(t, filepath.Join(esp, "EFI", "Linux", "whombat-recovery.efi"), []sec{{name: ".linux", data: []byte("k")}})

	stubs, err := Stubs(esp)
	if err != nil || len(stubs) != 1 || stubs[0] != stub {
		t.Fatalf("stubs %v %v", stubs, err)
	}
	st, err := ReadStub(stub)
	if err != nil {
		t.Fatal(err)
	}
	if !st.Thin {
		t.Fatal("lanzaboote stub not recognised as thin")
	}
	dir := t.TempDir()
	args, err := st.MeasureArgs(esp, dir)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"--linux=" + filepath.Join(esp, "EFI/nixos/kernel-x.efi"),
		"--osrel=" + filepath.Join(dir, "osrel"),
		"--cmdline=" + filepath.Join(dir, "cmdline"),
		"--initrd=" + filepath.Join(esp, "EFI/nixos/initrd-x.efi"),
		"--sbat=" + filepath.Join(dir, "sbat"),
	}
	if strings.Join(args, " ") != strings.Join(want, " ") {
		t.Fatalf("args\n got %v\nwant %v", args, want)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "sbat")); !bytes.Equal(b, []byte("sbat,1\n\x00\x00\x00")) {
		t.Fatalf("sbat %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "osrel")); string(b) != "ID=nixos\n" {
		t.Fatalf("osrel %q (raw padding must not be measured)", b)
	}

	// A kernel on the ESP that doesn't match the stub's hash is refused (the stub would refuse to boot it).
	_ = os.WriteFile(filepath.Join(esp, "EFI", "nixos", "kernel-x.efi"), []byte("other"), 0o644)
	if _, err := st.MeasureArgs(esp, t.TempDir()); err == nil {
		t.Fatal("hash mismatch accepted")
	}
}

func TestESPPathConfined(t *testing.T) {
	for _, p := range []string{`\EFI\..\..\etc\shadow`, "", `\`} {
		if _, err := espPath("/boot", []byte(p)); err == nil {
			t.Errorf("%q accepted", p)
		}
	}
}

func TestPCR15FromLog(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	uuid := "5f4dcc3b-0000-4000-8000-000000000001"
	m := hmac.New(sha256.New, key)
	m.Write([]byte("cryptsetup:whombat-root:" + uuid))
	d := hex.EncodeToString(m.Sum(nil))
	rec := func(pcr int, s, typ, digest string) string {
		return "\x1e{\"pcr\":" + strconv.Itoa(pcr) + ",\"digests\":[{\"hashAlg\":\"sha1\",\"digest\":\"00\"},{\"hashAlg\":\"sha256\",\"digest\":\"" + digest +
			"\"}],\"content_type\":\"systemd\",\"content\":{\"string\":\"" + s + "\",\"eventType\":\"" + typ + "\"}}\n"
	}
	log := rec(11, "enter-initrd", "phase", strings.Repeat("ab", 32)) + rec(15, "cryptsetup:whombat-root:"+uuid, "volume-key", d)
	got, err := PCR15FromLog(strings.NewReader(log), "whombat-root")
	if err != nil {
		t.Fatal(err)
	}
	if want := PCR15FromVolumeKey(key, "whombat-root", uuid); got != want {
		t.Fatalf("got %s want %s", got, want)
	}
	// Anything measured into PCR 15 before the root volume makes the value unpredictable: refused.
	if _, err := PCR15FromLog(strings.NewReader(rec(15, "machine-id:x", "machine-id", strings.Repeat("cd", 32))+log), "whombat-root"); err == nil {
		t.Fatal("earlier PCR 15 event accepted")
	}
	if _, err := PCR15FromLog(strings.NewReader(rec(11, "enter-initrd", "phase", strings.Repeat("ab", 32))), "whombat-root"); err != ErrNoRootMeasurement {
		t.Fatalf("err %v", err)
	}
}

// fakeMeasure is a stand-in systemd-measure: it logs its arguments and appends one entry per call.
func fakeMeasure(t *testing.T, dir string) (bin, log string) {
	bin, log = filepath.Join(dir, "systemd-measure"), filepath.Join(dir, "measure.log")
	script := `#!/bin/sh
echo "$*" >> ` + log + `
app=""
for a in "$@"; do case "$a" in --append=*) app="${a#--append=}";; esac; done
e='{"pcrs":[11],"pkfp":"fp","pol":"'$(echo "$*" | cksum | cut -d' ' -f1)'","sig":"c2ln"}'
if [ -n "$app" ]; then sed 's/]}$//' "$app" | tr -d '\n'; printf ',%s]}' "$e"; else printf '{"sha256":[%s]}' "$e"; fi
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin, log
}

// generation writes a system (toplevel) and the lanzaboote stub that boots it.
func generation(t *testing.T, esp, sys, name string, kernel, initrd []byte) string {
	t.Helper()
	os.MkdirAll(sys, 0o755)
	os.WriteFile(filepath.Join(sys, "kernel"), kernel, 0o644)
	os.WriteFile(filepath.Join(sys, "initrd"), initrd, 0o644)
	os.WriteFile(filepath.Join(sys, "kernel-params"), []byte("quiet panic=10\n"), 0o644)
	os.MkdirAll(filepath.Join(esp, "EFI", "nixos"), 0o755)
	os.MkdirAll(filepath.Join(esp, "EFI", "Linux"), 0o755)
	os.WriteFile(filepath.Join(esp, "EFI", "nixos", "kernel-"+name+".efi"), kernel, 0o644)
	os.WriteFile(filepath.Join(esp, "EFI", "nixos", "initrd-"+name+".efi"), initrd, 0o644)
	stub := filepath.Join(esp, "EFI", "Linux", "nixos-generation-"+name+".efi")
	buildPE(t, stub, []sec{
		{name: ".osrel", data: []byte("ID=nixos\n")},
		{name: ".cmdline", data: []byte("init=" + sys + "/init quiet panic=10")},
		{name: ".initrd", data: []byte(`\EFI\nixos\initrd-` + name + `.efi`)},
		{name: ".linux", data: []byte(`\EFI\nixos\kernel-` + name + `.efi`)},
		{name: ".initrdh", data: sum(initrd)},
		{name: ".linuxh", data: sum(kernel)},
	})
	return stub
}

// Regression for N-1 (re-review): only stubs of generations in the root-owned system profile are signed;
// a stub for any other system on the (unencrypted) ESP is refused. Only enter-initrd is signed (N-2).
func TestSignOnlyRecordedGenerations(t *testing.T) {
	d := t.TempDir()
	esp := filepath.Join(d, "esp")
	g1, g2, old := filepath.Join(d, "store", "g1-system"), filepath.Join(d, "store", "g2-system"), filepath.Join(d, "store", "old-system")
	generation(t, esp, g1, "1", []byte("k1"), []byte("i1"))
	generation(t, esp, g2, "2", []byte("k2"), []byte("i2"))
	generation(t, esp, old, "0", []byte("k0"), []byte("i0")) // pruned from the profile, stub left/copied back
	// A stub claiming g1 but loading another kernel.
	forged := generation(t, esp, filepath.Join(d, "store", "x"), "9", []byte("kx"), []byte("ix"))
	buildPE(t, forged, []sec{
		{name: ".cmdline", data: []byte("init=" + g1 + "/init quiet panic=10")},
		{name: ".initrd", data: []byte(`\EFI\nixos\initrd-9.efi`)},
		{name: ".linux", data: []byte(`\EFI\nixos\kernel-9.efi`)},
		{name: ".initrdh", data: sum([]byte("ix"))},
		{name: ".linuxh", data: sum([]byte("kx"))},
	})
	measure, log := fakeMeasure(t, d)
	out := filepath.Join(esp, "EFI", "whombat", "tpm2-pcr-signature.json")
	res, err := Sign(SignOptions{ESP: esp, Keys: []KeyPair{{"k.key", "k.pub"}}, Toplevels: []string{g1, g2}, Output: out, Measure: measure})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(res.Signed, ",") != g1+","+g2 || len(res.Refused) != 2 {
		t.Fatalf("signed %v refused %v", res.Signed, res.Refused)
	}
	b, _ := os.ReadFile(log)
	if strings.Contains(string(b), "kernel-0") || strings.Contains(string(b), "kernel-9") {
		t.Fatalf("unrecorded stub measured:\n%s", b)
	}
	if strings.Count(string(b), "--phase=enter-initrd") != 2 {
		t.Fatalf("not signed for enter-initrd only:\n%s", b)
	}
	// Two valid copies (N-6); re-signing replaces both.
	first, _ := os.ReadFile(out)
	if cp, _ := os.ReadFile(FallbackPath(out)); !bytes.Equal(cp, first) || !ValidSignature(first) {
		t.Fatal("second copy missing")
	}
	if _, err := Sign(SignOptions{ESP: esp, Keys: []KeyPair{{"k.key", "k.pub"}, {"n.key", "n.pub"}}, Toplevels: []string{g1, g2}, Output: out, Measure: measure}); err != nil {
		t.Fatal(err)
	}
	cur, _ := os.ReadFile(out)
	if cp, _ := os.ReadFile(FallbackPath(out)); !ValidSignature(cur) || bytes.Equal(cur, first) || !bytes.Equal(cp, cur) {
		t.Fatalf("new document not written twice: %s", cur)
	}
	// A torn primary is simply replaced; the copy stays valid throughout.
	os.WriteFile(out, []byte(`{"sha256":[{"pcrs":[11],"po`), 0o644)
	if err := WriteSignature(out, first); err != nil {
		t.Fatal(err)
	}
	if cp, _ := os.ReadFile(FallbackPath(out)); !bytes.Equal(cp, first) {
		t.Fatal("copy not updated")
	}
	if err := WriteSignature(out, []byte("{}")); err == nil {
		t.Fatal("invalid document written")
	}
}

// N-1: the record says which systems a key signed; one that left the profile needs a key rotation.
func TestRecordRevoked(t *testing.T) {
	p := filepath.Join(t.TempDir(), "signed.json")
	r, _ := LoadRecord(p)
	r.Add("cur", []string{"/s/a", "/s/b"})
	r.Add("next", []string{"/s/b"}, "cur")
	r.Save(p)
	r, _ = LoadRecord(p)
	if got := r.Revoked("cur", []string{"/s/b"}); strings.Join(got, ",") != "/s/a" {
		t.Fatalf("revoked %v", got)
	}
	if got := r.Revoked("next", []string{"/s/b"}); len(got) != 0 {
		t.Fatalf("revoked %v", got)
	}
	r.Add("next", nil) // rotation done: the old key's entries go
	if _, ok := r.Keys["cur"]; ok {
		t.Fatal("old key kept")
	}
}
