package clients

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// Provider is a client provider (claude, codex).
type Provider = release.ClientProvider

// Providers are the providers the manager knows, in the order they are reported.
var Providers = []Provider{release.ClientProviderClaude, release.ClientProviderCodex}

// Version is one installed (or previously installed) client version.
type Version struct {
	Version        string    `json:"version"`
	InstalledAt    time.Time `json:"installedAt"`
	PublishedAt    int64     `json:"publishedAt"`
	ExecPath       string    `json:"execPath"`
	SHA256         string    `json:"sha256"`
	Size           int64     `json:"size"`
	FixturesDigest string    `json:"fixturesDigest"`
	// RetiredAt: when a newer version replaced it (previous versions only).
	RetiredAt *time.Time `json:"retiredAt,omitempty"`
}

// ProviderState is what the manager keeps per provider (manager-private, under /persist).
type ProviderState struct {
	// Chosen: an owner installed it; the manager keeps it installed and up to date until it is removed.
	Chosen    bool                   `json:"chosen"`
	State     local.LocalClientState `json:"state"`
	Installed *Version               `json:"installed,omitempty"`
	// Previous versions, newest first: the first one stays for rollback, the others for at least Retain.
	Previous []Version               `json:"previous,omitempty"`
	Error    *local.LocalClientError `json:"error,omitempty"`
	// FailedVersion / FailedAt / Attempts: automatic retries of a failed version back off.
	FailedVersion string    `json:"failedVersion,omitempty"`
	FailedAt      time.Time `json:"failedAt,omitempty"`
	Attempts      int       `json:"attempts,omitempty"`
}

type fileState struct {
	V                int       `json:"v"`
	ChannelSequence  int64     `json:"channelSequence"`
	ChannelCheckedAt time.Time `json:"channelCheckedAt,omitempty"`
	// Adapters: the runtime's adapter levels as last reported (nil: not reported).
	Adapters  *local.RuntimeFactsClientAdapters `json:"adapters,omitempty"`
	Providers map[Provider]*ProviderState       `json:"providers"`
}

func loadState(p string) (*fileState, error) {
	st := &fileState{V: 1, Providers: map[Provider]*ProviderState{}}
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, st); err != nil {
		return nil, err
	}
	if st.Providers == nil {
		st.Providers = map[Provider]*ProviderState{}
	}
	return st, nil
}

func (s *fileState) save(p string) error {
	b, err := json.MarshalIndent(s, "", " ")
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(p, b, 0o600)
}

func (s *fileState) provider(p Provider) *ProviderState {
	ps := s.Providers[p]
	if ps == nil {
		ps = &ProviderState{State: local.LocalClientStateNotInstalled}
		s.Providers[p] = ps
	}
	return ps
}
