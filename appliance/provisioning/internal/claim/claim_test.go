package claim

import (
	"net/url"
	"regexp"
	"strings"
	"testing"
)

func TestSecret(t *testing.T) {
	s, err := NewSecret(nil)
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[A-Z2-7]{26}$`).MatchString(s) {
		t.Fatalf("secret %q is not 26 base32 characters (128 bits)", s)
	}
	d := Display(s)
	if Normalize(strings.ToLower(d)) != s || Normalize(strings.ReplaceAll(d, "-", " ")) != s || !Valid(Normalize(d)) {
		t.Fatal("display form does not normalise back")
	}
	s2, _ := NewSecret(nil)
	if s == s2 {
		t.Fatal("two secrets are equal")
	}
}

func TestNormalizeRules(t *testing.T) {
	cases := map[string]string{
		"abcd-efgh ijkl\tmnop\nqrst-uvwx-yz": "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
		"0O1I8B":                             "OOIIBB",
		" ab-cd ":                            "ABCD",
	}
	for in, want := range cases {
		if got := Normalize(in); got != want {
			t.Fatalf("Normalize(%q) = %q, want %q", in, got, want)
		}
	}
	if !Valid("ABCDEFGHIJKLMNOPQRSTUVWXYZ") || Valid("ABCDEFGHIJKLMNOPQRSTUVWXY") || Valid("ABCDEFGHIJKLMNOPQRSTUVWXY9") || Valid("ÄBCDEFGHIJKLMNOPQRSTUVWXYZ") {
		t.Fatal("Valid")
	}
}

func TestSecretHashBindsDevice(t *testing.T) {
	a := SecretHash("dev_1", "MZXW-6YTB-OI2D-AMRT-GQ3D-MNZY-HE")
	if a != SecretHash("dev_1", "mzxw6ytboi2damrtgq3dmnzyhe") {
		t.Fatal("hash is not over the normalised secret")
	}
	if a == SecretHash("dev_2", "MZXW6YTBOI2DAMRTGQ3DMNZYHE") || len(a) != 43 {
		t.Fatal("hash does not bind the device id")
	}
}

func TestRecoveryKeyFormat(t *testing.T) {
	k, err := NewRecoveryKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[cbdefghijklnrtuv]{8}(-[cbdefghijklnrtuv]{8}){7}$`).MatchString(k) {
		t.Fatalf("recovery key %q is not systemd's modhex format", k)
	}
}

func TestURLKeepsEverythingInTheFragment(t *testing.T) {
	u := URL("https://dev.whombat.com/claim", "dev_1", "12D3KooWA4Xop1JaT3MHxwYMkCepYsv4iPVopMXwCz5iHYdBfeSB", "abcd-efgh")
	base, frag, ok := strings.Cut(u, "#")
	if !ok || base != "https://dev.whombat.com/claim" {
		t.Fatalf("url %s", u)
	}
	v, err := url.ParseQuery(frag)
	if err != nil || v.Get("d") != "dev_1" || v.Get("s") != "ABCDEFGH" || v.Get("v") != "1" ||
		v.Get("p") != "12D3KooWA4Xop1JaT3MHxwYMkCepYsv4iPVopMXwCz5iHYdBfeSB" {
		t.Fatalf("fragment %s", frag)
	}
	for _, env := range []string{"local", "dev", "prod"} {
		if _, err := URLBase(env); err != nil {
			t.Fatal(err)
		}
	}
}
