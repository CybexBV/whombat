// Package keyslots removes a previous owner's keys from a LUKS2 volume (W4-SEC part 2 re-review N-7).
// A factory reset recreates /persist, but the system volume keeps its keyslots: without this, the old
// owner's disk recovery key would still open root, where the maintenance key of the new owner's /persist
// lives. Reset keeps exactly the TPM2 token slots, the maintenance slot and the passphrases it is told to
// keep, and kills every other slot. With rotate it also replaces the maintenance key. It is crash-safe: the
// slots it keeps are never touched, the new maintenance key is added (and its file written as <key>.new)
// before anything is removed, and a rerun resumes from <key>.new.
package keyslots

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Cryptsetup runs cryptsetup with an optional stdin and returns stdout+stderr.
type Cryptsetup func(ctx context.Context, stdin string, args ...string) (string, error)

var unlockedRe = regexp.MustCompile(`Key slot (\d+) unlocked`)

// slotOf returns the keyslot a key file (or, with file "-", the stdin passphrase) opens.
func slotOf(ctx context.Context, cs Cryptsetup, dev, file, stdin string) (int, error) {
	out, err := cs(ctx, stdin, "open", "--test-passphrase", "--verbose", "--key-file="+file, dev)
	if err != nil {
		return -1, err
	}
	m := unlockedRe.FindStringSubmatch(out)
	if m == nil {
		return -1, fmt.Errorf("cryptsetup did not report the key slot: %s", strings.TrimSpace(out))
	}
	return strconv.Atoi(m[1])
}

type metadata struct {
	Keyslots map[string]json.RawMessage `json:"keyslots"`
	Tokens   map[string]struct {
		Type     string   `json:"type"`
		Keyslots []string `json:"keyslots"`
	} `json:"tokens"`
}

func slots(ctx context.Context, cs Cryptsetup, dev string) (all []int, tpm map[int]bool, err error) {
	out, err := cs(ctx, "", "luksDump", "--dump-json-metadata", dev)
	if err != nil {
		return nil, nil, err
	}
	var md metadata
	if err := json.Unmarshal([]byte(out), &md); err != nil {
		return nil, nil, fmt.Errorf("luksDump: %w", err)
	}
	tpm = map[int]bool{}
	for _, t := range md.Tokens {
		if t.Type != "systemd-tpm2" {
			continue
		}
		for _, k := range t.Keyslots {
			n, err := strconv.Atoi(k)
			if err == nil {
				tpm[n] = true
			}
		}
	}
	for k := range md.Keyslots {
		if n, err := strconv.Atoi(k); err == nil {
			all = append(all, n)
		}
	}
	sort.Ints(all)
	return all, tpm, nil
}

func writeKey(p string) error {
	b := make([]byte, 48)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(base64.StdEncoding.EncodeToString(b)); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func syncDir(d string) {
	if f, err := os.Open(d); err == nil {
		_ = f.Sync()
		f.Close()
	}
}

// Options for Reset.
type Options struct {
	Device   string
	MaintKey string   // maintenance key file (maint-<volume>.key)
	Keep     []string // passphrases whose slots stay (e.g. the new owner's recovery key)
	Rotate   bool     // replace the maintenance key
}

// Result reports what Reset did.
type Result struct {
	Killed  []int
	Rotated bool
}

// Reset keeps the TPM2 slots, the maintenance slot and the Keep passphrases' slots and kills every other
// keyslot of the volume.
func Reset(ctx context.Context, cs Cryptsetup, o Options) (*Result, error) {
	key := o.MaintKey
	next := o.MaintKey + ".new"
	res := &Result{}
	if o.Rotate {
		if _, err := os.Stat(next); err != nil || func() bool { _, e := slotOf(ctx, cs, o.Device, next, ""); return e != nil }() {
			// No usable <key>.new: add a fresh maintenance key, authorized by the current one.
			if _, err := slotOf(ctx, cs, o.Device, key, ""); err != nil {
				return nil, fmt.Errorf("the maintenance key does not open %s: %w", o.Device, err)
			}
			if err := writeKey(next); err != nil {
				return nil, err
			}
			syncDir(filepath.Dir(next))
			if _, err := cs(ctx, "", "luksAddKey", "--batch-mode", "--pbkdf", "pbkdf2", "--iter-time", "200",
				"--key-file="+key, o.Device, next); err != nil {
				return nil, fmt.Errorf("add the new maintenance key: %w", err)
			}
		}
		key = next
	}
	keep := map[int]bool{}
	ms, err := slotOf(ctx, cs, o.Device, key, "")
	if err != nil {
		return nil, fmt.Errorf("the maintenance key does not open %s: %w", o.Device, err)
	}
	keep[ms] = true
	for _, p := range o.Keep {
		n, err := slotOf(ctx, cs, o.Device, "-", p)
		if err != nil {
			return nil, fmt.Errorf("a passphrase to keep does not open %s: %w", o.Device, err)
		}
		keep[n] = true
	}
	all, tpm, err := slots(ctx, cs, o.Device)
	if err != nil {
		return nil, err
	}
	if len(tpm) == 0 {
		return nil, errors.New("no TPM2 slot: refusing to remove keyslots (the device could only be opened with the maintenance key)")
	}
	for n := range tpm {
		keep[n] = true
	}
	for _, n := range all {
		if keep[n] {
			continue
		}
		if _, err := cs(ctx, "", "luksKillSlot", "--batch-mode", "--key-file="+key, o.Device, strconv.Itoa(n)); err != nil {
			return res, fmt.Errorf("remove key slot %d: %w", n, err)
		}
		res.Killed = append(res.Killed, n)
	}
	if o.Rotate {
		// The old maintenance slot was among the killed ones (it is neither kept nor TPM).
		if err := os.Rename(next, o.MaintKey); err != nil {
			return res, err
		}
		syncDir(filepath.Dir(o.MaintKey))
		res.Rotated = true
	}
	return res, nil
}
