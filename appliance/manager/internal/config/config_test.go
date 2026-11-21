package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The edition (MG-136): commercial needs control, community refuses one; absent is commercial (every image before it).
func TestEdition(t *testing.T) {
	d := t.TempDir()
	load := func(edition, controlURL string) (*Config, error) {
		c := map[string]any{"deviceFile": "/d", "managementKey": "/k", "control": map[string]any{"url": controlURL},
			"tuf":        map[string]any{"pinnedRoot": "/r", "metadataUrl": "http://u/m/", "targetsUrl": "http://u/t/", "cacheDir": "/c", "mirrorDir": "/m"},
			"stagingDir": "/s", "journalDir": "/persist/manager/journal", "assignmentPath": "/a", "knownGoodDir": "/g",
			"helperSocket": "/h", "apiSocket": "/api", "runtime": map[string]any{"adminSocket": "/admin"}}
		if edition != "-" {
			c["edition"] = edition
		}
		b, _ := json.Marshal(c)
		p := filepath.Join(d, "manager.json")
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
		return Load(p)
	}
	for _, tc := range []struct {
		edition, url string
		community    bool
		err          string
	}{
		{"-", "https://api.example", false, ""},
		{"commercial", "https://api.example", false, ""},
		{"community", "", true, ""},
		{"community", "https://api.example", false, "no control"},
		{"commercial", "", false, "control.url is required"},
		{"-", "", false, "control.url is required"},
		{"enterprise", "https://api.example", false, "unknown edition"},
	} {
		c, err := load(tc.edition, tc.url)
		switch {
		case tc.err != "" && (err == nil || !strings.Contains(err.Error(), tc.err)):
			t.Errorf("%s %q: %v, want %q", tc.edition, tc.url, err, tc.err)
		case tc.err == "" && (err != nil || c.Community() != tc.community):
			t.Errorf("%s %q: %+v %v", tc.edition, tc.url, c, err)
		}
	}
}

// The own address has no configuration field (MG-161): the manager refuses unknown fields, so a field an image set
// would break a rollback to an older known-good manager. Zone and directory come from the device's env and
// WHOMBAT_OWN_ADDRESS instead.
func TestNoOwnAddressField(t *testing.T) {
	d := t.TempDir()
	base := map[string]any{"deviceFile": "/d", "managementKey": "/k", "control": map[string]any{"url": "https://api.example"},
		"tuf":        map[string]any{"pinnedRoot": "/r", "metadataUrl": "http://u/m/", "targetsUrl": "http://u/t/", "cacheDir": "/c", "mirrorDir": "/m"},
		"stagingDir": "/s", "journalDir": "/persist/manager/journal", "assignmentPath": "/a", "knownGoodDir": "/g",
		"helperSocket": "/h", "apiSocket": "/api", "runtime": map[string]any{"adminSocket": "/admin"}}
	for _, field := range []string{"ownAddress", "ownAddressZone", "acmeDirectory", "acmeSocket"} {
		c := map[string]any{field: "x"}
		for k, v := range base {
			c[k] = v
		}
		b, _ := json.Marshal(c)
		p := filepath.Join(d, "manager.json")
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(p); err == nil || !strings.Contains(err.Error(), "unknown field") {
			t.Fatalf("%s: %v, want an unknown field", field, err)
		}
	}
	for _, f := range []string{"OwnAddress", "Acme", "ACME", "CertSpotter"} {
		if strings.Contains(strings.ToLower(configFields()), strings.ToLower(f)) {
			t.Fatalf("Config has a field about %s", f)
		}
	}
}

// configFields lists Config's JSON field names, nested ones included.
func configFields() string {
	b, _ := json.Marshal(Config{})
	return string(b)
}

// preBridgeTUF is the tuf section as the manager before the GitHub layout reads it (origin/main, the known-good
// manager of every box that takes the bridge release): its decoder refuses keys it doesn't know.
type preBridgeTUF struct {
	PinnedRoot  string `json:"pinnedRoot"`
	MetadataURL string `json:"metadataUrl"`
	TargetsURL  string `json:"targetsUrl"`
	CacheDir    string `json:"cacheDir"`
	MirrorDir   string `json:"mirrorDir"`
}

// The GitHub layout comes from the units' environment (Whombat LNK-24): the bridge's manager.json stays readable by
// the previous manager, which the recovery unit runs with the same file when the new one fails; the new manager takes
// the layout from WHOMBAT_TUF_TARGETS_LAYOUT. A layout in the file still counts (tests), an unknown one is refused.
func TestTargetsLayoutFromTheEnvironment(t *testing.T) {
	d := t.TempDir()
	write := func(tuf map[string]any) string {
		c := map[string]any{"deviceFile": "/d", "managementKey": "/k", "control": map[string]any{"url": "https://api.example"},
			"tuf": tuf, "stagingDir": "/s", "journalDir": "/persist/manager/journal", "assignmentPath": "/a", "knownGoodDir": "/g",
			"helperSocket": "/h", "apiSocket": "/api", "runtime": map[string]any{"adminSocket": "/admin"}}
		b, _ := json.Marshal(c)
		p := filepath.Join(d, "manager.json")
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	bridge := map[string]any{"pinnedRoot": "/r", "metadataUrl": "https://releases.example.com/",
		"targetsUrl": "https://github.com/example/releases/releases/download/", "cacheDir": "/c", "mirrorDir": "/m"}
	p := write(bridge)
	// The previous manager's rule.
	var old struct {
		TUF preBridgeTUF `json:"tuf"`
	}
	raw, _ := os.ReadFile(p)
	var top map[string]json.RawMessage
	_ = json.Unmarshal(raw, &top)
	dec := json.NewDecoder(strings.NewReader(string(top["tuf"])))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&old.TUF); err != nil {
		t.Fatalf("the previous manager can't read the bridge's tuf section: %v", err)
	}
	t.Setenv(EnvTargetsLayout, TargetsLayoutGitHub)
	c, err := Load(p)
	if err != nil || c.TUF.TargetsLayout != TargetsLayoutGitHub {
		t.Fatalf("layout from the environment: %+v %v", c, err)
	}
	t.Setenv(EnvTargetsLayout, "")
	if c, err := Load(p); err != nil || c.TUF.TargetsLayout != "" {
		t.Fatalf("no layout: %+v %v", c, err)
	}
	t.Setenv(EnvTargetsLayout, "s3")
	if _, err := Load(p); err == nil || !strings.Contains(err.Error(), "targetsLayout") {
		t.Fatalf("an unknown layout from the environment: %v", err)
	}
	bridge["targetsLayout"] = TargetsLayoutGitHub
	if c, err := Load(write(bridge)); err != nil || c.TUF.TargetsLayout != TargetsLayoutGitHub {
		t.Fatalf("layout in the file: %+v %v", c, err)
	}
	dec = json.NewDecoder(strings.NewReader(`{"pinnedRoot":"/r","targetsLayout":"github"}`))
	dec.DisallowUnknownFields()
	if dec.Decode(&old.TUF) == nil {
		t.Fatal("the previous manager's rule accepts targetsLayout: the test no longer models it")
	}
}
