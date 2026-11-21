package diagnose

import (
	"os"
	"strings"
	"testing"
)

func TestRedactConfig(t *testing.T) {
	b, err := os.ReadFile("testdata/unraid/var/local/emhttp/var.ini")
	if err != nil {
		t.Fatal(err)
	}
	out := redactConfig(string(b))
	if strings.Contains(out, "7C2E9B1A44D0F3E6") || !strings.Contains(out, `csrf_token="<redacted>"`+"\n") ||
		!strings.Contains(out, `mdState="STARTED"`) || len(strings.Split(out, "\n")) != len(strings.Split(string(b), "\n")) {
		t.Fatalf("var.ini:\n%s", out)
	}
	for in, want := range map[string]string{
		"cipassword: $5$abc":                        "cipassword: <redacted>",
		"  api_key = 'k-123'":                       "  api_key = '<redacted>'",
		"Token: abc":                                "Token: <redacted>",
		"password:":                                 "password:",
		"lxc.environment: DB_PASSWORD=x":            "lxc.environment: DB_PASSWORD=<redacted>",
		"args: -drive file=x,secret=abc,format=raw": "args: -drive file=x,secret=<redacted>,format=raw",
		"url: https://u:pw@example.com/x":           "url: https://u:<redacted>@example.com/x",
		"memory: 8192":                              "memory: 8192",
		`"privateKey": "abc",`:                      `"privateKey": <redacted>`,
		"nameserver 10.100.0.1":                     "nameserver 10.100.0.1",
	} {
		if got := redactConfig(in); got != want {
			t.Errorf("%q: %q (want %q)", in, got, want)
		}
	}
}

func TestRedactArgs(t *testing.T) {
	for in, want := range map[string]string{
		"mysqld --password=s3 --user=mysql":  "mysqld --password=<redacted> --user=mysql",
		"app --api-key abc --port 80":        "app --api-key <redacted> --port 80",
		"app --token --verbose":              "app --token --verbose",
		"curl https://bob:pw@host/api":       "curl https://bob:<redacted>@host/api",
		"sshd: /usr/sbin/sshd -D [listener]": "sshd: /usr/sbin/sshd -D [listener]",
	} {
		if got := redactArgs(in); got != want {
			t.Errorf("%q: %q (want %q)", in, got, want)
		}
	}
}
