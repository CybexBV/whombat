package devtuf

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/contracts/go/release"
)

const nix32 = "0123456789abcdfghijklmnpqrsvwxyz"

// FakeStorePath returns a deterministic, syntactically valid Nix store path for fixtures.
func FakeStorePath(name string) string {
	sum := sha256.Sum256([]byte(name))
	b := make([]byte, 32)
	for i := range b {
		b[i] = nix32[int(sum[i%32]+byte(i))%32]
	}
	return "/nix/store/" + string(b) + "-" + name
}

func fakeNarHash(content []byte) string {
	sum := sha256.Sum256(append([]byte("nar:"), content...))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// FakeNar is the "NAR" of a fixture path: "nar:" + its content, so its sha256 is the fixture's NAR hash
// (fakeNarHash). The fake activator stores a path imported from such a NAR without the prefix (the fixture content).
func FakeNar(content []byte) []byte { return append([]byte(FakeNarPrefix), content...) }

// FakeNarPrefix starts every fixture NAR.
const FakeNarPrefix = "nar:"

// FakeProvider describes a fixture provider bundle.
type FakeProvider struct {
	Name    string
	Version string
}

// FakeRelease describes a fixture release tuple. The artifact contents are small JSON documents
// that the fake activator/fake runtime interpret (FakeArtifact).
type FakeRelease struct {
	ID             string
	HostVersion    string
	HostABI        int64
	ManagerVersion string // default HostVersion
	RuntimeVersion string
	RuntimeHostABI release.IntRange
	SchemaReads    release.IntRange
	SchemaWrites   int64
	// Protocol is the runtime's session protocol range (`major*1000+minor`); zero is {1000, 1000}.
	Protocol release.IntRange
	// SchemaReadOnlyMax (fake runtime only): newer schemas up to this are usable read-only.
	SchemaReadOnlyMax int64
	// ContractMigration (fake only): migrating to SchemaWrites needs a verified checkpoint (MD-06).
	ContractMigration bool
	// ReaderFloor/WriterFloor (fake only): the floors of SchemaWrites the runtime reports in its schema check
	// (Whombat MD-12) and records when it migrates; 0 for a runtime before MD-12.
	ReaderFloor, WriterFloor int64
	// RuntimeHealth is what the fake runtime reports when this runtime is active: "ok" or "bad".
	RuntimeHealth string
	// HostBoots is false for a host generation that fails to boot (fake boot fallback).
	HostBoots bool
	// PadBytes makes the host's and the runtime's content (and their blobs) larger (capacity tests).
	PadBytes  int
	Providers []FakeProvider
	// AllowDowngradeFrom: releases a device may move back from to this one (custody-signed rollback).
	AllowDowngradeFrom []string
	// ClientFloor is the tuple's client security floor (CT-53); nil publishes a tuple without one.
	ClientFloor *release.ClientFloor
}

// FakeLibPath is the store path every fixture closure shares (its blob is published once). Every component's closure
// index lists [FakeLibPath, (the manager,) the component]; the "NAR" of a path is FakeNar(its content).
var FakeLibPath = FakeStorePath("whombat-fake-lib-1")

// FakeLibContent is FakeLibPath's fixture content.
var FakeLibContent = []byte("fake shared library 1\n")

// FakeArtifact is the content of fixture artifacts.
type FakeArtifact struct {
	Fake              bool   `json:"fake"`
	Kind              string `json:"kind"`
	Name              string `json:"name"`
	Version           string `json:"version"`
	StorePath         string `json:"storePath"`
	RuntimeHealth     string `json:"runtimeHealth,omitempty"`
	SchemaWrites      int64  `json:"schemaWrites,omitempty"`
	SchemaReadMin     int64  `json:"schemaReadMin,omitempty"`
	SchemaReadMax     int64  `json:"schemaReadMax,omitempty"`
	SchemaReadOnlyMax int64  `json:"schemaReadOnlyMax,omitempty"`
	ContractMigration bool   `json:"contractMigration,omitempty"`
	ReaderFloor       int64  `json:"readerFloor,omitempty"`
	WriterFloor       int64  `json:"writerFloor,omitempty"`
	HostBoots         *bool  `json:"hostBoots,omitempty"`
	Pad               string `json:"pad,omitempty"`
}

// pad is n characters that don't compress (a blob grows with them): base64 of a hash chain.
func pad(n int) string {
	if n <= 0 {
		return ""
	}
	var b []byte
	sum := sha256.Sum256([]byte("whombat fixture pad"))
	for len(b)*4/3 < n {
		b = append(b, sum[:]...)
		sum = sha256.Sum256(sum[:])
	}
	return base64.StdEncoding.EncodeToString(b)[:n]
}

// AddFakeRelease adds the host, runtime and provider closure indexes (with their blobs) and the approved tuple (not
// yet published).
func (r *Repo) AddFakeRelease(f FakeRelease) (release.ReleaseTuple, error) {
	if f.RuntimeHealth == "" {
		f.RuntimeHealth = "ok"
	}
	if f.ManagerVersion == "" {
		f.ManagerVersion = f.HostVersion
	}
	narOf := fakeNarHash
	lib := FakeNarPath{StorePath: FakeLibPath, Content: FakeLibContent, References: []string{}}
	// add publishes one component's index.
	add := func(indexTarget string, content []byte, meta trust.ArtifactMeta, extra ...FakeNarPath) error {
		refs := []string{lib.StorePath}
		paths := []FakeNarPath{lib}
		for _, e := range extra {
			refs = append(refs, e.StorePath)
			paths = append(paths, e)
		}
		paths = append(paths, FakeNarPath{StorePath: meta.StorePath, Content: content, References: refs})
		return r.AddFakeIndex(indexTarget, trust.IndexMeta{Kind: trust.KindClosureIndex, Of: meta.Kind, Version: meta.Version,
			StorePath: meta.StorePath, NarHash: meta.NarHash, ManagerStorePath: meta.ManagerStorePath, Provider: meta.Provider}, paths)
	}
	managerPath := FakeStorePath("whombat-manager-" + f.ManagerVersion)
	manager := FakeNarPath{StorePath: managerPath, Content: []byte(managerPath), References: []string{}}
	hostPath := FakeStorePath("nixos-system-whombat-" + f.HostVersion)
	boots := f.HostBoots
	hostContent, _ := json.Marshal(FakeArtifact{Fake: true, Kind: string(trust.KindHostGeneration), Name: "whombat-host",
		Version: f.HostVersion, StorePath: hostPath, HostBoots: &boots, Pad: pad(f.PadBytes)})
	hostNar := narOf(hostContent)
	if err := add(HostIndexTarget(f.HostVersion), hostContent, trust.ArtifactMeta{Kind: trust.KindHostGeneration,
		Version: f.HostVersion, Format: trust.ArtifactFormatNix, StorePath: hostPath, NarHash: hostNar, ManagerStorePath: managerPath,
		ClosureSize: int64(len(hostContent))}, manager); err != nil {
		return release.ReleaseTuple{}, err
	}
	rtPath := FakeStorePath("whombat-runtime-" + f.RuntimeVersion)
	rtContent, _ := json.Marshal(FakeArtifact{Fake: true, Kind: string(trust.KindRuntimeBundle), Name: "whombat-runtime",
		Version: f.RuntimeVersion, StorePath: rtPath, RuntimeHealth: f.RuntimeHealth, SchemaWrites: f.SchemaWrites,
		SchemaReadMin: f.SchemaReads.Min, SchemaReadMax: f.SchemaReads.Max, SchemaReadOnlyMax: f.SchemaReadOnlyMax,
		ContractMigration: f.ContractMigration, ReaderFloor: f.ReaderFloor, WriterFloor: f.WriterFloor, Pad: pad(f.PadBytes)})
	rtNar := narOf(rtContent)
	if err := add(RuntimeIndexTarget(f.RuntimeVersion), rtContent, trust.ArtifactMeta{Kind: trust.KindRuntimeBundle,
		Version: f.RuntimeVersion, Format: trust.ArtifactFormatNix, StorePath: rtPath, NarHash: rtNar, ClosureSize: int64(len(rtContent))}); err != nil {
		return release.ReleaseTuple{}, err
	}
	protocol := f.Protocol
	if protocol == (release.IntRange{}) {
		protocol = release.IntRange{Min: 1000, Max: 1000}
	}
	t := release.ReleaseTuple{
		ReleaseID: f.ID,
		Runtime: release.ReleaseTupleRuntime{Version: f.RuntimeVersion, StorePath: rtPath, NarHash: rtNar,
			SchemaReads: f.SchemaReads, SchemaWrites: f.SchemaWrites, Protocol: protocol,
			HostABI: f.RuntimeHostABI},
		Providers: []release.ReleaseTupleProvidersItem{},
		Host:      release.ReleaseTupleHost{Version: f.HostVersion, StorePath: hostPath, NarHash: hostNar, ABI: f.HostABI},
		Manager:   release.Component{Version: f.ManagerVersion, StorePath: managerPath, NarHash: narOf(manager.Content)},
	}
	if f.ClientFloor != nil {
		floor := *f.ClientFloor
		t.ClientFloor = &floor
	}
	for _, p := range f.Providers {
		pPath := FakeStorePath("whombat-provider-" + p.Name + "-" + p.Version)
		pContent, _ := json.Marshal(FakeArtifact{Fake: true, Kind: string(trust.KindProviderBundle), Name: p.Name, Version: p.Version, StorePath: pPath})
		pNar := narOf(pContent)
		if err := add(ProviderIndexTarget(p.Name, p.Version), pContent, trust.ArtifactMeta{Kind: trust.KindProviderBundle,
			Version: p.Version, Format: trust.ArtifactFormatNix, StorePath: pPath, NarHash: pNar, Provider: p.Name, ClosureSize: int64(len(pContent))}); err != nil {
			return release.ReleaseTuple{}, err
		}
		t.Providers = append(t.Providers, release.ReleaseTupleProvidersItem{Version: p.Version, StorePath: pPath, NarHash: pNar, Provider: p.Name})
	}
	return t, r.AddReleaseAllowingDowngrade(t, f.AllowDowngradeFrom...)
}

// StandardRelease returns a compatible fixture release (schema 10, host ABI 3).
func StandardRelease(id, hostVersion, runtimeVersion string) FakeRelease {
	return FakeRelease{
		ID: id, HostVersion: hostVersion, HostABI: 3, RuntimeVersion: runtimeVersion,
		RuntimeHostABI: release.IntRange{Min: 2, Max: 4}, SchemaReads: release.IntRange{Min: 9, Max: 11}, SchemaWrites: 10,
		RuntimeHealth: "ok", HostBoots: true, Providers: []FakeProvider{{Name: "codex", Version: "0.50.0"}},
	}
}
