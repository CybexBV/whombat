// Package recoverykey is the disk recovery key of a self-installed appliance from an image before PI-19 (PI-04,
// NX-53…NX-56): its format and its Argon2id hash on /persist. Images since PI-19 create none; an appliance that
// holds a hash keeps it, and the recovery menu and erase check keys against it.
//
// The key has systemd-cryptenroll's recovery-key format (the factory card's, NX-12): 32 bytes from the kernel
// CRNG as 64 modhex characters in 8 dash-separated groups of 8.
//
// Files (all on /persist):
//
//	secrets/recovery-key.argon2id    0600 root                      PHC string
//	console/recovery-key.json        0440 root:whombat-console      the key an earlier image left for the console
//	                                                                until confirmed; removed at boot with its
//	                                                                hash (whombat-provision recovery-key drop-pending)
package recoverykey

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/crypto/argon2"
)

// Alphabet is systemd's modhex alphabet (16 symbols that read the same on every keyboard layout).
const Alphabet = "cbdefghijklnrtuv"

// Files, relative to the persist directory.
const (
	HashFile    = "secrets/recovery-key.argon2id"
	PendingDir  = "console"
	PendingFile = "console/recovery-key.json"
)

// Groups and GroupLen describe the display form: 8 groups of 8 characters.
const (
	Groups   = 8
	GroupLen = 8
)

var canonicalRe = regexp.MustCompile(`^[cbdefghijklnrtuv]{8}(-[cbdefghijklnrtuv]{8}){7}$`)

// New returns a new key from r (crypto/rand when nil).
func New(r io.Reader) (string, error) {
	if r == nil {
		r = rand.Reader
	}
	var b [32]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		return "", err
	}
	var sb strings.Builder
	for i, c := range b {
		if i > 0 && i%4 == 0 {
			sb.WriteByte('-')
		}
		sb.WriteByte(Alphabet[c>>4])
		sb.WriteByte(Alphabet[c&0xf])
	}
	return sb.String(), nil
}

// Valid reports whether s is a key in its canonical form (lower case, 8 groups of 8, single dashes).
func Valid(s string) bool { return canonicalRe.MatchString(s) }

// Normalize turns a typed key into its canonical form: ASCII lower case, every whitespace character and
// dash removed, then exactly 64 modhex characters regrouped. Nothing else is repaired.
func Normalize(s string) (string, error) {
	var b strings.Builder
	for _, r := range s {
		switch {
		case unicode.IsSpace(r) || r == '-' || r == '\uFEFF':
			continue
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r + ('a' - 'A'))
		default:
			b.WriteRune(r)
		}
	}
	flat := b.String()
	if len(flat) != Groups*GroupLen {
		return "", errors.New("a recovery key has 64 letters in 8 groups of 8")
	}
	var out strings.Builder
	for i := 0; i < len(flat); i++ {
		if strings.IndexByte(Alphabet, flat[i]) < 0 {
			return "", errors.New("a recovery key has only the letters " + Alphabet)
		}
		if i > 0 && i%GroupLen == 0 {
			out.WriteByte('-')
		}
		out.WriteByte(flat[i])
	}
	return out.String(), nil
}

// ---- Argon2id -----------------------------------------------------------------------------------

// Params are Argon2id parameters.
type Params struct {
	MemoryKiB uint32
	Time      uint32
	Threads   uint8
}

// DefaultParams: 64 MiB, 3 passes, 4 lanes (RFC 9106's second recommended option; it fits the recovery
// environment's RAM). A 256-bit random key needs no stretching against guessing; Argon2id is PI-04's choice
// and keeps the file useless as a fast oracle should the key format ever get shorter.
var DefaultParams = Params{MemoryKiB: 64 * 1024, Time: 3, Threads: 4}

const (
	saltLen = 16
	hashLen = 32
	// Bounds on parameters read from a file: a crafted file must not exhaust the recovery environment.
	maxMemoryKiB = 1024 * 1024
	maxTime      = 64
)

var b64 = base64.RawStdEncoding

// Hash returns the PHC string ($argon2id$v=19$m=…,t=…,p=…$salt$hash) of the canonical key.
func Hash(r io.Reader, key string, p Params) (string, error) {
	if !Valid(key) {
		return "", errors.New("not a canonical recovery key")
	}
	if r == nil {
		r = rand.Reader
	}
	salt := make([]byte, saltLen)
	if _, err := io.ReadFull(r, salt); err != nil {
		return "", err
	}
	sum := argon2.IDKey([]byte(key), salt, p.Time, p.MemoryKiB, p.Threads, hashLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, p.MemoryKiB, p.Time, p.Threads,
		b64.EncodeToString(salt), b64.EncodeToString(sum)), nil
}

// ErrBadHash: the hash file is not an Argon2id PHC string this package wrote.
var ErrBadHash = errors.New("the recovery key hash is not a valid Argon2id record")

// ParseHash checks a PHC string and returns its parts.
func ParseHash(phc string) (p Params, salt, sum []byte, err error) {
	parts := strings.Split(strings.TrimSpace(phc), "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" || parts[2] != "v="+strconv.Itoa(argon2.Version) {
		return p, nil, nil, ErrBadHash
	}
	var m, t, par uint64
	for _, kv := range strings.Split(parts[3], ",") {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			return p, nil, nil, ErrBadHash
		}
		n, err := strconv.ParseUint(v, 10, 32)
		if err != nil {
			return p, nil, nil, ErrBadHash
		}
		switch k {
		case "m":
			m = n
		case "t":
			t = n
		case "p":
			par = n
		default:
			return p, nil, nil, ErrBadHash
		}
	}
	if m < 8 || m > maxMemoryKiB || t < 1 || t > maxTime || par < 1 || par > 255 {
		return p, nil, nil, ErrBadHash
	}
	if salt, err = b64.DecodeString(parts[4]); err != nil || len(salt) < 8 {
		return p, nil, nil, ErrBadHash
	}
	if sum, err = b64.DecodeString(parts[5]); err != nil || len(sum) != hashLen {
		return p, nil, nil, ErrBadHash
	}
	return Params{MemoryKiB: uint32(m), Time: uint32(t), Threads: uint8(par)}, salt, sum, nil
}

// Verify reports whether typed (any form Normalize accepts) is the key of the PHC string.
func Verify(phc, typed string) (bool, error) {
	p, salt, sum, err := ParseHash(phc)
	if err != nil {
		return false, err
	}
	key, err := Normalize(typed)
	if err != nil {
		return false, nil
	}
	got := argon2.IDKey([]byte(key), salt, p.Time, p.MemoryKiB, p.Threads, uint32(len(sum)))
	return subtle.ConstantTimeCompare(got, sum) == 1, nil
}
