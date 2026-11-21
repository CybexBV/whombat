package ownaddress

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// The state directory's files (MG-161): `<dir of journalDir>/own-address/`, 0700, every file 0600, the manager user's.
// The keys never leave it except as the runtime's copy of the current pair, which it needs to serve the page.
const (
	stateFile   = "state.json"
	accountFile = "account.key"
	orderedFile = "ordered.json"
	ctFile      = "ct.json"
	// orderedMax is the contract's bound on `ordered` (the newest are kept).
	orderedMax = 64
)

// Saved is state.json: the registered label and which pair is current.
type Saved struct {
	Label        string `json:"label,omitempty"`
	Host         string `json:"host,omitempty"`
	RegisteredAt int64  `json:"registeredAt,omitempty"`
	// Current and Previous are serials of pairs in the directory (`<serial>.key`, `<serial>.pem`); Previous is kept so
	// a pair the runtime fetched a moment before a renewal still exists on disk while it swaps.
	Current  string `json:"current,omitempty"`
	Previous string `json:"previous,omitempty"`
	// Directory is the ACME directory Current came from: a pair from another one (staging before production) is
	// replaced at once.
	Directory string `json:"directory,omitempty"`
}

// Pair is a certificate chain and its key, as the runtime serves them.
type Pair struct {
	Meta      local.OwnAddressCertMeta
	CertPEM   string
	KeyPEM    string
	NotBefore time.Time
	NotAfter  time.Time
}

// RenewAt is two thirds into the certificate's lifetime (MG-162).
func (p *Pair) RenewAt() time.Time {
	return p.NotBefore.Add(p.NotAfter.Sub(p.NotBefore) * 2 / 3)
}

// Store is the state directory. Its methods are safe for concurrent use.
type Store struct {
	dir string
	mu  sync.Mutex
}

// OpenStore creates the directory (0700) if needed and tightens it if it was looser.
func OpenStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return nil, err
	}
	return &Store{dir: dir}, nil
}

// Dir is the state directory.
func (s *Store) Dir() string { return s.dir }

func (s *Store) path(name string) string { return filepath.Join(s.dir, name) }

func (s *Store) readJSON(name string, v any) error {
	b, err := os.ReadFile(s.path(name))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, v); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

func (s *Store) writeJSON(name string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(s.path(name), append(b, '\n'), 0o600)
}

// State reads state.json (zero when there is none yet).
func (s *Store) State() (Saved, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var v Saved
	err := s.readJSON(stateFile, &v)
	return v, err
}

// SaveState replaces state.json.
func (s *Store) SaveState(v Saved) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.writeJSON(stateFile, v)
}

// AccountKey is the ACME account key, made on first use: ECDSA P-256, 0600, never sent anywhere.
func (s *Store) AccountKey() (crypto.Signer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.path(accountFile)
	if b, err := os.ReadFile(p); err == nil {
		return parseKey(b)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	b, err := marshalKey(k)
	if err != nil {
		return nil, err
	}
	if err := atomicfile.WriteFile(p, b, 0o600); err != nil {
		return nil, err
	}
	return k, nil
}

func marshalKey(k *ecdsa.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalECPrivateKey(k)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), nil
}

func parseKey(b []byte) (crypto.Signer, error) {
	blk, _ := pem.Decode(b)
	if blk == nil {
		return nil, errors.New("not a PEM key")
	}
	return x509.ParseECPrivateKey(blk.Bytes)
}

var serialRe = regexp.MustCompile(`^[0-9a-f]{2,64}$`)

// MetaOf describes a leaf certificate as the contract does: its serial in lower-case hex (even length, no colons),
// the SHA-256 of its SubjectPublicKeyInfo (Cert Spotter's pubkey_sha256) and its dates.
func MetaOf(leaf *x509.Certificate) local.OwnAddressCertMeta {
	serial := leaf.SerialNumber.Text(16)
	if len(serial)%2 == 1 {
		serial = "0" + serial
	}
	return local.OwnAddressCertMeta{Serial: serial, SpkiSHA256: SPKIHash(leaf),
		NotBefore: leaf.NotBefore.UTC().Format(time.RFC3339), NotAfter: leaf.NotAfter.UTC().Format(time.RFC3339)}
}

// SPKIHash is the hex SHA-256 of the certificate's DER SubjectPublicKeyInfo.
func SPKIHash(c *x509.Certificate) string {
	h := sha256.Sum256(c.RawSubjectPublicKeyInfo)
	return hex.EncodeToString(h[:])
}

// SavePair writes a new pair's files (key first, both 0600) and records it in ordered.json. It doesn't make it
// current: SaveState does, once both files are on disk.
func (s *Store) SavePair(chain [][]byte, key *ecdsa.PrivateKey) (*Pair, error) {
	if len(chain) == 0 {
		return nil, errors.New("an empty chain")
	}
	leaf, err := x509.ParseCertificate(chain[0])
	if err != nil {
		return nil, err
	}
	meta := MetaOf(leaf)
	if !serialRe.MatchString(meta.Serial) {
		return nil, fmt.Errorf("serial %q out of the contract's shape", meta.Serial)
	}
	keyPEM, err := marshalKey(key)
	if err != nil {
		return nil, err
	}
	var certPEM []byte
	for _, d := range chain {
		certPEM = append(certPEM, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: d})...)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := atomicfile.WriteFile(s.path(meta.Serial+".key"), keyPEM, 0o600); err != nil {
		return nil, err
	}
	if err := atomicfile.WriteFile(s.path(meta.Serial+".pem"), certPEM, 0o600); err != nil {
		return nil, err
	}
	var ordered []local.OwnAddressCertMeta
	if err := s.readJSON(orderedFile, &ordered); err != nil {
		return nil, err
	}
	ordered = slices.DeleteFunc(ordered, func(m local.OwnAddressCertMeta) bool { return m.Serial == meta.Serial })
	ordered = append([]local.OwnAddressCertMeta{meta}, ordered...)
	if len(ordered) > orderedMax {
		ordered = ordered[:orderedMax]
	}
	if err := s.writeJSON(orderedFile, ordered); err != nil {
		return nil, err
	}
	return &Pair{Meta: meta, CertPEM: string(certPEM), KeyPEM: string(keyPEM), NotBefore: leaf.NotBefore, NotAfter: leaf.NotAfter}, nil
}

// Pair reads a saved pair and checks that its key belongs to its certificate.
func (s *Store) Pair(serial string) (*Pair, error) {
	if !serialRe.MatchString(serial) {
		return nil, fmt.Errorf("serial %q out of shape", serial)
	}
	s.mu.Lock()
	certPEM, err := os.ReadFile(s.path(serial + ".pem"))
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	keyPEM, err := os.ReadFile(s.path(serial + ".key"))
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	tc, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, err
	}
	leaf, err := x509.ParseCertificate(tc.Certificate[0])
	if err != nil {
		return nil, err
	}
	return &Pair{Meta: MetaOf(leaf), CertPEM: string(certPEM), KeyPEM: string(keyPEM), NotBefore: leaf.NotBefore, NotAfter: leaf.NotAfter}, nil
}

// Prune removes pair files other than keep's (an old previous pair, or one an interrupted save left behind).
func (s *Store) Prune(keep ...string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		name := e.Name()
		serial, ok := strings.CutSuffix(name, ".key")
		if !ok {
			serial, ok = strings.CutSuffix(name, ".pem")
		}
		if !ok || !serialRe.MatchString(serial) || slices.Contains(keep, serial) {
			continue
		}
		if err := os.Remove(s.path(name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// Ordered is what this manager ordered, newest first.
func (s *Store) Ordered() ([]local.OwnAddressCertMeta, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ordered := []local.OwnAddressCertMeta{}
	err := s.readJSON(orderedFile, &ordered)
	return ordered, err
}

// CTState is ct.json: what the certificate watch knows (MG-165).
type CTState struct {
	// Host is the name the record is about; a record for another name starts over.
	Host string `json:"host"`
	// CheckingSince is when this box first started watching that name.
	CheckingSince time.Time `json:"checkingSince"`
	// LastFresh is the last fresh, complete answer; zero before the first.
	LastFresh time.Time `json:"lastFresh,omitzero"`
	// Missed are the closed windows of more than 12 hours without a fresh check, oldest first.
	Missed []Window `json:"missed"`
	// Certs is the last fresh answer, names already filtered.
	Certs []local.OwnAddressCtCert `json:"certs"`
}

// Window is a stretch of time without a fresh check.
type Window struct {
	From time.Time `json:"from"`
	To   time.Time `json:"to"`
}

// CT reads ct.json (nil when there is none yet).
func (s *Store) CT() (*CTState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := os.Stat(s.path(ctFile)); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	var v CTState
	if err := s.readJSON(ctFile, &v); err != nil {
		return nil, err
	}
	return &v, nil
}

// SaveCT replaces ct.json.
func (s *Store) SaveCT(v *CTState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.writeJSON(ctFile, v)
}
