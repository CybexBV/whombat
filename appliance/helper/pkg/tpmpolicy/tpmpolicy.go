// Package tpmpolicy computes the inputs of the appliance's TPM2 disk-unlock policy (MA-21b, NX-12):
//
//   - PCR 11: the boot stub measures the unified-kernel-image sections of the generation it boots
//     (lanzaboote's stub measures exactly like systemd-stub). The device signs the expected PCR 11
//     values of every generation on its ESP with its own policy key (systemd-measure), so the TPM
//     releases the disk keys only for those images, never for the recovery UKI or any other image that
//     happens to carry a valid Secure Boot signature.
//   - PCR 15: systemd-cryptsetup (tpm2-measure-pcr=yes) extends PCR 15 with an HMAC of the root volume
//     key when it opens the root volume. /persist is sealed to the resulting value, so it only opens after
//     the device's own root volume was opened.
//
// It has no dependency on the TPM: it reads PE files, the userspace measurement log and runs
// systemd-measure (pure computation plus signing).
package tpmpolicy

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"debug/pe"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
)

// measured are the UKI sections the stub extends into PCR 11, in canonical order (UKI specification;
// lanzaboote's UnifiedSection order). .dtbauto and .pcrsig are never measured.
var measured = []string{".linux", ".osrel", ".cmdline", ".initrd", ".ucode", ".splash", ".dtb", ".hwids", ".uname", ".sbat", ".pcrpkey"}

// Stub is a boot stub (lanzaboote "thin" stub or a complete UKI) as the stub itself measures it.
type Stub struct {
	Path string
	// Sections holds the measured sections present, with the bytes the stub reads: the first
	// min(VirtualSize, SizeOfRawData) bytes, zero-padded to VirtualSize.
	Sections map[string][]byte
	// Thin is true for a lanzaboote stub: .linux/.initrd hold ESP paths of the kernel and initrd,
	// .linuxh/.initrdh their SHA-256, and the stub measures the files' contents.
	Thin   bool
	hashes map[string][]byte
}

// ReadStub parses a PE boot stub.
func ReadStub(path string) (*Stub, error) {
	f, err := pe.Open(path)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	defer f.Close()
	s := &Stub{Path: path, Sections: map[string][]byte{}, hashes: map[string][]byte{}}
	want := map[string]bool{".linuxh": true, ".initrdh": true}
	for _, n := range measured {
		want[n] = true
	}
	for _, sec := range f.Sections {
		if !want[sec.Name] {
			continue
		}
		raw, err := sec.Data()
		if err != nil {
			return nil, fmt.Errorf("%s: section %s: %w", path, sec.Name, err)
		}
		n := min(int(sec.VirtualSize), len(raw))
		data := make([]byte, sec.VirtualSize)
		copy(data, raw[:n])
		switch sec.Name {
		case ".linuxh", ".initrdh":
			s.hashes[sec.Name] = data
		default:
			s.Sections[sec.Name] = data
		}
	}
	if _, ok := s.Sections[".linux"]; !ok {
		return nil, fmt.Errorf("%s: no .linux section (not a boot stub)", path)
	}
	s.Thin = len(s.hashes[".linuxh"]) == sha256.Size
	return s, nil
}

// espPath turns a stub's ESP path ("\EFI\nixos\kernel-….efi", maybe NUL-terminated) into a path under esp.
func espPath(esp string, raw []byte) (string, error) {
	p := strings.TrimRight(string(raw), "\x00")
	p = strings.ReplaceAll(p, `\`, "/")
	clean := filepath.Clean("/" + p)
	if p == "" || strings.Contains(p, "..") || clean == "/" {
		return "", fmt.Errorf("bad ESP path %q", p)
	}
	return filepath.Join(esp, clean), nil
}

func fileSHA256(p string) ([]byte, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return nil, err
	}
	return h.Sum(nil), nil
}

// MeasureArgs returns the systemd-measure section arguments that reproduce what the stub measures.
// Section contents are written to dir; a thin stub's kernel and initrd are the files on the ESP (checked
// against the stub's own hashes, as the stub does at boot).
func (s *Stub) MeasureArgs(esp, dir string) ([]string, error) {
	var args []string
	for _, name := range measured {
		data, ok := s.Sections[name]
		if !ok {
			continue
		}
		flag := "--" + strings.TrimPrefix(name, ".")
		if s.Thin && (name == ".linux" || name == ".initrd") {
			p, err := espPath(esp, data)
			if err != nil {
				return nil, fmt.Errorf("%s: %s: %w", s.Path, name, err)
			}
			sum, err := fileSHA256(p)
			if err != nil {
				return nil, fmt.Errorf("%s: %s: %w", s.Path, name, err)
			}
			if want := s.hashes[name+"h"]; !bytes.Equal(sum, want) {
				return nil, fmt.Errorf("%s: %s does not match the stub's %sh", s.Path, p, name)
			}
			args = append(args, flag+"="+p)
			continue
		}
		f := filepath.Join(dir, strings.TrimPrefix(name, "."))
		if err := os.WriteFile(f, data, 0o600); err != nil {
			return nil, err
		}
		args = append(args, flag+"="+f)
	}
	return args, nil
}

// Stubs lists the generations lanzaboote installed on the ESP (EFI/Linux/nixos-*.efi, with or without a
// boot counter). Nothing else is ever signed, in particular not the recovery UKI.
func Stubs(esp string) ([]string, error) {
	ents, err := os.ReadDir(filepath.Join(esp, "EFI", "Linux"))
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range ents {
		n := e.Name()
		if e.Type().IsRegular() && strings.HasPrefix(n, "nixos-") && strings.HasSuffix(n, ".efi") {
			out = append(out, filepath.Join(esp, "EFI", "Linux", n))
		}
	}
	sort.Strings(out)
	return out, nil
}

// Toplevel returns the system (toplevel store path) a stub boots, from its command line (lzbt writes
// "init=<toplevel>/init <kernel-params>").
func (s *Stub) Toplevel() (string, error) {
	f := strings.Fields(strings.TrimRight(string(s.Sections[".cmdline"]), "\x00"))
	if len(f) == 0 || !strings.HasPrefix(f[0], "init=") || !strings.HasSuffix(f[0], "/init") {
		return "", fmt.Errorf("%s: command line does not start with init=<system>/init", s.Path)
	}
	return strings.TrimSuffix(strings.TrimPrefix(f[0], "init="), "/init"), nil
}

// CheckGeneration verifies that the stub boots exactly the given system: its command line is
// "init=<top>/init" plus the system's kernel-params, and the kernel and initrd it loads are the system's.
// An ESP stub that doesn't correspond to a recorded system is never signed (N-1).
func (s *Stub) CheckGeneration(esp, top string) error {
	params, err := os.ReadFile(filepath.Join(top, "kernel-params"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	want := append([]string{"init=" + top + "/init"}, strings.Fields(string(params))...)
	got := strings.Fields(strings.TrimRight(string(s.Sections[".cmdline"]), "\x00"))
	if strings.Join(got, " ") != strings.Join(want, " ") {
		return fmt.Errorf("%s: command line differs from %s", filepath.Base(s.Path), top)
	}
	if !s.Thin {
		return fmt.Errorf("%s: not a lanzaboote stub", filepath.Base(s.Path))
	}
	for sec, file := range map[string]string{".linux": "kernel", ".initrd": "initrd"} {
		p, err := espPath(esp, s.Sections[sec])
		if err != nil {
			return err
		}
		a, err := fileSHA256(p)
		if err != nil {
			return err
		}
		b, err := fileSHA256(filepath.Join(top, file))
		if err != nil {
			return err
		}
		if !bytes.Equal(a, b) {
			return fmt.Errorf("%s: %s is not %s/%s", filepath.Base(s.Path), p, top, file)
		}
	}
	return nil
}

// ProfileToplevels returns the systems of the root-owned system profile's generations
// (<profiles>/system-*-link): the only generations this device installed and may sign.
func ProfileToplevels(profiles string) ([]string, error) {
	links, err := filepath.Glob(filepath.Join(profiles, "system-*-link"))
	if err != nil {
		return nil, err
	}
	var out []string
	for _, l := range links {
		t, err := filepath.EvalSymlinks(l)
		if err != nil {
			continue
		}
		out = append(out, t)
	}
	sort.Strings(out)
	return out, nil
}

// KeyPair is a PCR policy signing key (PEM files).
type KeyPair struct{ Private, Public string }

// Fingerprint identifies a public key (hex SHA-256 of the PEM file).
func Fingerprint(pubPEM string) (string, error) {
	return fileHex(pubPEM)
}

func fileHex(p string) (string, error) {
	h, err := fileSHA256(p)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(h), nil
}

// SignOptions configure Sign.
type SignOptions struct {
	ESP string
	// Keys sign every allowed generation (two during a key rotation).
	Keys []KeyPair
	// Toplevels are the systems this device installed (ProfileToplevels). Stubs of anything else are
	// refused, whatever the ESP holds.
	Toplevels []string
	// Output is the primary signature file; the previous valid one is kept as FallbackPath(Output) (N-6).
	Output  string
	Measure string // systemd-measure binary
	// Phase is the boot phase path signed; default "enter-initrd": the TPM releases the disk keys only
	// in the initrd, never to the running system (N-2).
	Phase string
}

// SignResult reports what was signed.
type SignResult struct {
	Signed  []string // systems
	Refused []string // stub file: reason
}

// Sign signs the expected PCR 11 value (phase enter-initrd) of every ESP stub that boots one of the
// recorded systems and writes the combined signature JSON (systemd's tpm2-pcr-signature.json format).
func Sign(o SignOptions) (*SignResult, error) {
	if o.Phase == "" {
		o.Phase = "enter-initrd"
	}
	if len(o.Keys) == 0 {
		return nil, errors.New("no signing key")
	}
	stubs, err := Stubs(o.ESP)
	if err != nil {
		return nil, err
	}
	allowed := map[string]bool{}
	for _, t := range o.Toplevels {
		allowed[t] = true
	}
	work, err := os.MkdirTemp("", "whombat-tpm-policy-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(work)
	acc := filepath.Join(work, "acc.json")
	res := &SignResult{}
	n := 0
	for i, p := range stubs {
		st, err := ReadStub(p)
		if err != nil {
			res.Refused = append(res.Refused, filepath.Base(p)+": "+err.Error())
			continue
		}
		top, err := st.Toplevel()
		if err == nil && !allowed[top] {
			err = fmt.Errorf("%s is not a generation of the system profile", top)
		}
		if err == nil {
			err = st.CheckGeneration(o.ESP, top)
		}
		if err != nil {
			res.Refused = append(res.Refused, filepath.Base(p)+": "+err.Error())
			continue
		}
		dir := filepath.Join(work, fmt.Sprint(i))
		if err := os.Mkdir(dir, 0o700); err != nil {
			return nil, err
		}
		args, err := st.MeasureArgs(o.ESP, dir)
		if err != nil {
			return nil, err
		}
		for _, k := range o.Keys {
			argv := append([]string{"sign", "--bank=sha256", "--json=short", "--phase=" + o.Phase,
				"--private-key=" + k.Private, "--public-key=" + k.Public}, args...)
			if n > 0 {
				argv = append(argv, "--append="+acc)
			}
			cmd := exec.Command(o.Measure, argv...)
			var out, stderr bytes.Buffer
			cmd.Stdout, cmd.Stderr = &out, &stderr
			if err := cmd.Run(); err != nil {
				return nil, fmt.Errorf("systemd-measure sign %s: %v: %s", filepath.Base(p), err, strings.TrimSpace(stderr.String()))
			}
			if err := os.WriteFile(acc, out.Bytes(), 0o600); err != nil {
				return nil, err
			}
			n++
		}
		res.Signed = append(res.Signed, top)
	}
	if len(res.Signed) == 0 {
		return res, fmt.Errorf("no recorded generation on the ESP (refused: %v)", res.Refused)
	}
	data, err := os.ReadFile(acc)
	if err != nil {
		return nil, err
	}
	if err := WriteSignature(o.Output, data); err != nil {
		return nil, err
	}
	return res, nil
}

// ValidSignature reports whether data is a usable systemd PCR signature document.
func ValidSignature(data []byte) bool {
	var doc map[string][]struct {
		PCRs []int  `json:"pcrs"`
		Pol  string `json:"pol"`
		Sig  string `json:"sig"`
	}
	if json.Unmarshal(data, &doc) != nil || len(doc["sha256"]) == 0 {
		return false
	}
	for _, e := range doc["sha256"] {
		if len(e.PCRs) == 0 || e.Pol == "" || e.Sig == "" {
			return false
		}
	}
	return true
}

// FallbackPath is the second copy of the signature document.
func FallbackPath(p string) string { return strings.TrimSuffix(p, ".json") + ".copy.json" }

// WriteSignature validates data and writes it twice, one copy after the other (each tmp + fsync +
// rename): the ESP is FAT, not journaled, so a torn write damages at most the copy being written, and
// the initrd uses the first copy that is valid (N-6).
func WriteSignature(path string, data []byte) error {
	if !ValidSignature(data) {
		return errors.New("refusing to write an invalid PCR signature document")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	for _, p := range []string{path, FallbackPath(path)} {
		if cur, err := os.ReadFile(p); err == nil && bytes.Equal(cur, data) {
			continue
		}
		if err := atomicfile.WriteFile(p, data, 0o644); err != nil {
			return err
		}
		if b, err := os.ReadFile(p); err != nil || !bytes.Equal(b, data) {
			return fmt.Errorf("%s does not read back as written", p)
		}
	}
	return nil
}

// Record lists, per policy key (fingerprint), every system ever signed with it. A system that left the
// profile but was signed with the current key can still unseal: the key must be rotated (N-1).
type Record struct {
	V    int                 `json:"v"`
	Keys map[string][]string `json:"keys"`
}

// LoadRecord reads a record (empty when missing).
func LoadRecord(path string) (*Record, error) {
	r := &Record{V: 1, Keys: map[string][]string{}}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return r, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, r); err != nil {
		return nil, fmt.Errorf("signing record: %w", err)
	}
	if r.Keys == nil {
		r.Keys = map[string][]string{}
	}
	return r, nil
}

// Add records systems signed with key fp and keeps only the listed keys.
func (r *Record) Add(fp string, systems []string, keep ...string) {
	set := map[string]bool{}
	for _, s := range append(r.Keys[fp], systems...) {
		set[s] = true
	}
	var l []string
	for s := range set {
		l = append(l, s)
	}
	sort.Strings(l)
	r.Keys[fp] = l
	k := map[string]bool{fp: true}
	for _, x := range keep {
		k[x] = true
	}
	for x := range r.Keys {
		if !k[x] {
			delete(r.Keys, x)
		}
	}
}

// Save writes the record atomically.
func (r *Record) Save(path string) error {
	b, err := json.MarshalIndent(r, "", " ")
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(path, b, 0o600)
}

// Revoked returns the systems signed with key fp that are no longer allowed.
func (r *Record) Revoked(fp string, allowed []string) []string {
	a := map[string]bool{}
	for _, t := range allowed {
		a[t] = true
	}
	var out []string
	for _, s := range r.Keys[fp] {
		if !a[s] {
			out = append(out, s)
		}
	}
	return out
}

// VolumeKeyPrefix is the string systemd-cryptsetup measures (HMAC'd with the volume key) for a volume.
func VolumeKeyPrefix(volume, uuid string) string {
	return "cryptsetup:" + strings.ReplaceAll(volume, ":", `\x3a`) + ":" + uuid
}

// Extend returns SHA-256(pcr || digest), the TPM extend operation.
func Extend(pcr, digest []byte) []byte {
	h := sha256.New()
	h.Write(pcr)
	h.Write(digest)
	return h.Sum(nil)
}

// PCR15FromVolumeKey is the PCR 15 value after systemd-cryptsetup measured this volume key into a
// fresh PCR 15.
func PCR15FromVolumeKey(key []byte, volume, uuid string) string {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(VolumeKeyPrefix(volume, uuid)))
	return hex.EncodeToString(Extend(make([]byte, sha256.Size), m.Sum(nil)))
}

type logRecord struct {
	PCR     *int `json:"pcr"`
	Digests []struct {
		HashAlg string `json:"hashAlg"`
		Digest  string `json:"digest"`
	} `json:"digests"`
	Content struct {
		String    string `json:"string"`
		EventType string `json:"eventType"`
	} `json:"content"`
}

// ErrNoRootMeasurement: the log has no PCR 15 measurement of the root volume (the stub did not measure
// the boot, or the volume was opened without tpm2-measure-pcr).
var ErrNoRootMeasurement = errors.New("no PCR 15 volume-key measurement of the root volume in this boot")

// PCR15FromLog reads systemd's userspace measurement log (/run/log/systemd/tpm2-measure.log, JSON-SEQ)
// and returns the PCR 15 value right after the given volume was measured. The volume must be the first
// PCR 15 event of the boot: anything measured before it would make the value unpredictable.
func PCR15FromLog(r io.Reader, volume string) (string, error) {
	data, err := io.ReadAll(io.LimitReader(r, 16<<20))
	if err != nil {
		return "", err
	}
	pcr := make([]byte, sha256.Size)
	for _, rec := range bytes.Split(data, []byte{0x1e}) {
		rec = bytes.TrimSpace(rec)
		if len(rec) == 0 {
			continue
		}
		var l logRecord
		if err := json.Unmarshal(rec, &l); err != nil {
			return "", fmt.Errorf("measurement log: %w", err)
		}
		if l.PCR == nil || *l.PCR != 15 {
			continue
		}
		var digest []byte
		for _, d := range l.Digests {
			if d.HashAlg == "sha256" {
				if digest, err = hex.DecodeString(d.Digest); err != nil || len(digest) != sha256.Size {
					return "", fmt.Errorf("measurement log: bad sha256 digest %q", d.Digest)
				}
			}
		}
		if digest == nil {
			return "", errors.New("measurement log: PCR 15 event without a sha256 digest")
		}
		pcr = Extend(pcr, digest)
		if strings.HasPrefix(l.Content.String, "cryptsetup:"+volume+":") && l.Content.EventType == "volume-key" {
			if !bytes.Equal(pcr, Extend(make([]byte, sha256.Size), digest)) {
				return "", fmt.Errorf("PCR 15 was extended before %s was measured", volume)
			}
			return hex.EncodeToString(pcr), nil
		}
	}
	return "", ErrNoRootMeasurement
}
