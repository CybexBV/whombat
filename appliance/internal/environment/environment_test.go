package environment

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const image = `{"v":1,"default":"prod","environments":{
 "prod":{"deviceEnv":"prod","controlUrl":"https://api.example.com","appUrl":"https://app.example.com","ownAddressZone":"box.example.com",
   "files":{"support-ca.pub":"/etc/whombat/environments/prod/support-ca.pub"}},
 "dev":{"deviceEnv":"local","controlUrl":"https://api-dev.example.com","appUrl":"https://dev.example.com","embedUrl":"https://embed-dev.example.com",
   "ownAddressZone":"dev.example.com","files":{"client-channel-keys.json":"/etc/whombat/environments/dev/client-channel-keys.json"},
   "runtime":{"WHOMBAT_MERGE_RERUN":"Example/repo=infrastructure"}},
 "test":{"deviceEnv":"local","controlUrl":"","appUrl":""}}}`

func files(t *testing.T, box string) (string, string) {
	t.Helper()
	dir := t.TempDir()
	im := filepath.Join(dir, "environments.json")
	if err := os.WriteFile(im, []byte(image), 0o644); err != nil {
		t.Fatal(err)
	}
	bx := filepath.Join(dir, "environment.json")
	if box != "" {
		if err := os.WriteFile(bx, []byte(box), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return im, bx
}

func TestAbsentIsTheImagesDefault(t *testing.T) {
	im, bx := files(t, "")
	r, err := Resolve(im, bx)
	if err != nil || r.Name != "prod" || r.Chosen || r.ControlURL != "https://api.example.com" || !r.LinkAvailable() {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestTheBoxFilePicks(t *testing.T) {
	im, bx := files(t, `{"v":1,"env":"dev"}`)
	r, err := Resolve(im, bx)
	if err != nil || r.Name != "dev" || !r.Chosen || r.DeviceEnv != "local" || r.OwnAddressZone != "dev.example.com" {
		t.Fatalf("%+v %v", r, err)
	}
	if r2, _ := Resolve(im, writeBox(t, bx, `{"v":1,"env":"test"}`)); r2.LinkAvailable() {
		t.Fatal("an environment without control has Link")
	}
}

func writeBox(t *testing.T, path, s string) string {
	t.Helper()
	if err := os.WriteFile(path, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// A broken or unknown choice never falls back quietly; a file can't carry addresses of its own.
func TestABadBoxFileIsAnError(t *testing.T) {
	for _, box := range []string{`{"v":1,"env":"staging"}`, `{"v":2,"env":"dev"}`, `not json`,
		`{"v":1,"env":"dev","controlUrl":"https://evil.example.com"}`} {
		im, bx := files(t, box)
		if _, err := Resolve(im, bx); err == nil {
			t.Errorf("%s: resolved", box)
		}
	}
	im, bx := files(t, `{"v":1,"env":"staging"}`)
	if _, err := Resolve(im, bx); !errors.Is(err, ErrUnknown) {
		t.Fatal(err)
	}
}

func TestABadImageIsRefused(t *testing.T) {
	for _, im := range []string{
		`{"v":1,"default":"x","environments":{"prod":{"deviceEnv":"prod","controlUrl":"","appUrl":""}}}`,
		`{"v":1,"default":"prod","environments":{"prod":{"deviceEnv":"staging","controlUrl":"","appUrl":""}}}`,
		`{"v":1,"default":"prod","environments":{"prod":{"deviceEnv":"prod","controlUrl":"http://api.example.com","appUrl":""}}}`,
		`{"v":1,"default":"prod","environments":{"prod":{"deviceEnv":"prod","controlUrl":"","appUrl":"","files":{"x":"/a"}}}}`,
		`{"v":1,"default":"prod","environments":{"prod":{"deviceEnv":"prod","controlUrl":"","appUrl":"","runtime":{"PATH":"/x"}}}}`,
		`{"v":1,"default":"prod","environments":{"prod":{"deviceEnv":"prod","controlUrl":"","appUrl":"","runtime":{"WHOMBAT_X":"a b"}}}}`,
	} {
		if _, err := ParseImage([]byte(im)); err == nil {
			t.Errorf("accepted %s", im)
		}
	}
}

// The bridge release's one-shot (LNK-50): idempotent, never over a choice already made.
func TestSet(t *testing.T) {
	im, bx := files(t, "")
	if wrote, err := Set(im, bx, "dev", true); err != nil || !wrote {
		t.Fatal(wrote, err)
	}
	if b, _ := os.ReadFile(bx); string(b) != "{\"v\":1,\"env\":\"dev\"}\n" {
		t.Fatalf("%q", b)
	}
	if fi, _ := os.Stat(bx); fi.Mode().Perm() != 0o644 {
		t.Fatal(fi.Mode())
	}
	if wrote, err := Set(im, bx, "dev", true); err != nil || wrote {
		t.Fatal("wrote again", err)
	}
	if wrote, err := Set(im, bx, "prod", true); err != nil || wrote {
		t.Fatal("--if-absent replaced a choice", err)
	}
	if wrote, err := Set(im, bx, "prod", false); err != nil || !wrote {
		t.Fatal(wrote, err)
	}
	if _, err := Set(im, bx, "staging", false); !errors.Is(err, ErrUnknown) {
		t.Fatal(err)
	}
}

func TestWriteRun(t *testing.T) {
	im, bx := files(t, `{"v":1,"env":"dev"}`)
	run := filepath.Join(t.TempDir(), "run")
	r, _ := Resolve(im, bx)
	if err := WriteRun(r, run); err != nil {
		t.Fatal(err)
	}
	env, _ := os.ReadFile(filepath.Join(run, RuntimeEnvName))
	want := "WHOMBAT_APP_URL=https://dev.example.com\nWHOMBAT_EMBED_URL=https://embed-dev.example.com\nWHOMBAT_ENV=local\n" +
		"WHOMBAT_ENVIRONMENT=dev\nWHOMBAT_MERGE_RERUN=Example/repo=infrastructure\n"
	if string(env) != want {
		t.Fatalf("%q", env)
	}
	if l, err := os.Readlink(filepath.Join(run, ClientsKeysName)); err != nil || !strings.HasSuffix(l, "/dev/client-channel-keys.json") {
		t.Fatal(l, err)
	}
	got, err := Load(run)
	if err != nil || got.Name != "dev" || got.ControlURL != r.ControlURL {
		t.Fatalf("%+v %v", got, err)
	}
	// Back to production: the development stack's documents are gone, production's are there.
	writeBox(t, bx, `{"v":1,"env":"prod"}`)
	r, _ = Resolve(im, bx)
	if err := WriteRun(r, run); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(run, ClientsKeysName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the development keys stayed")
	}
	if _, err := os.Readlink(filepath.Join(run, SupportCAName)); err != nil {
		t.Fatal(err)
	}
}

func TestAProblemMeansNoEnvironment(t *testing.T) {
	run := filepath.Join(t.TempDir(), "run")
	im, bx := files(t, `{"v":1,"env":"dev"}`)
	r, _ := Resolve(im, bx)
	if err := WriteRun(r, run); err != nil {
		t.Fatal(err)
	}
	if err := WriteProblem(run, errors.New("this image has no such environment: \"staging\"")); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(run); err == nil || errors.Is(err, os.ErrNotExist) || !strings.Contains(err.Error(), "staging") {
		t.Fatal(err)
	}
	for _, name := range []string{RuntimeEnvName, ClientsKeysName} {
		if _, err := os.Lstat(filepath.Join(run, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s stayed", name)
		}
	}
}
