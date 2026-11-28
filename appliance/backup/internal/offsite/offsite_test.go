package offsite

import "testing"

// Plain http only to a literal address on the owner's own network: private, this machine or link-local, IPv4 or IPv6.
// The runtime's check of the address (apps/server/src/managed/backup-offsite.ts) takes the same table.
func TestPlainHTTPOnlyAtHome(t *testing.T) {
	for host, want := range map[string]bool{
		"192.168.1.20:9000": true, "10.0.0.5": true, "172.16.0.1": true, "127.0.0.1:9000": true, "169.254.10.10": true,
		"[fd00::1]:9000": true, "[::1]": true, "[fe80::1]": true, "[::ffff:192.168.1.20]": true,
		"203.0.113.9": false, "172.32.0.1": false, "s3.example.com": false, "localhost:9000": false,
		"[2001:db8::1]": false, "[::ffff:203.0.113.9]": false,
	} {
		if got := plainHTTPAllowed(host); got != want {
			t.Errorf("%s: %v, want %v", host, got, want)
		}
	}
}
