package wall

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/vaultwall/internal/networks"
)

var testSets = Sets{Table: "inet whombat-egress", Set4: "vault4", Set6: "vault6"}

func elements(t *testing.T, data string) (v4, v6 []networks.Element) {
	t.Helper()
	nets, err := networks.Parse([]byte(data))
	if err != nil {
		t.Fatal(err)
	}
	return networks.Elements(nets)
}

func TestScript(t *testing.T) {
	v4, v6 := elements(t, `{"version":1,"networks":[
		{"cidr":"192.168.1.0/24","ports":[8123,80]},
		{"cidr":"192.168.1.10/32","ports":[9000]},
		{"cidr":"fd12:3456:789a::/48","ports":[8123]},
		{"cidr":"fd12:3456:789a:1::5/128","ports":[443]}]}`)
	got := testSets.Script(v4, v6)
	want := `flush set inet whombat-egress vault4
flush set inet whombat-egress vault6
add element inet whombat-egress vault4 {
  192.168.1.0/24 . 80,
  192.168.1.0/24 . 8123,
  192.168.1.10 . 9000
}
add element inet whombat-egress vault6 {
  fd12:3456:789a::/48 . 8123,
  fd12:3456:789a:1::5 . 443
}
`
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
	if got := testSets.Script(nil, nil); got != "flush set inet whombat-egress vault4\nflush set inet whombat-egress vault6\n" {
		t.Fatalf("empty: %q", got)
	}
}

// The egress table's Vault part as nix/modules/network.nix declares it (sets and rules), for the real-nft test.
const testTable = `table inet whombat-egress {
  set vault4 { type ipv4_addr . inet_service; flags interval; }
  set vault6 { type ipv6_addr . inet_service; flags interval; }
  chain vault_established {
    ip daddr . tcp dport @vault4 return
    ip6 daddr . tcp dport @vault6 return
    counter reject with tcp reset
  }
  chain output {
    type filter hook output priority filter; policy drop;
    oifname "lo" accept
    ct mark 0x5641554c jump vault_established
    ct state established,related accept
    meta skuid 951 ip daddr . tcp dport @vault4 ct mark set 0x5641554c accept
    meta skuid 951 ip6 daddr . tcp dport @vault6 ct mark set 0x5641554c accept
    counter drop
  }
}
`

// nftInNamespace runs a shell script with $NFT as root of a fresh user and network namespace, or skips.
func nftInNamespace(t *testing.T, script string) string {
	t.Helper()
	nft := os.Getenv("WHOMBAT_TEST_NFT")
	if nft == "" {
		var err error
		if nft, err = exec.LookPath("nft"); err != nil {
			t.Skip("no nft (set WHOMBAT_TEST_NFT)")
		}
	}
	unshare, err := exec.LookPath("unshare")
	if err != nil {
		t.Skip("no unshare")
	}
	if out, err := exec.Command(unshare, "-rn", nft, "list", "ruleset").CombinedOutput(); err != nil {
		t.Skipf("no user and network namespaces here: %v %s", err, out)
	}
	cmd := exec.Command(unshare, "-rn", "sh", "-euc", script)
	cmd.Env = append(os.Environ(), "NFT="+nft)
	cmd.Dir = t.TempDir()
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	return string(out)
}

// The real nft accepts the transaction, replaces the elements atomically, and merged overlaps load (an interval
// set refuses overlapping elements).
func TestScriptWithRealNFT(t *testing.T) {
	d := t.TempDir()
	write(t, filepath.Join(d, "table.nft"), testTable, 0o644)
	v4, v6 := elements(t, `{"version":1,"networks":[
		{"cidr":"192.168.0.0/16","ports":[80]},
		{"cidr":"192.168.1.0/24","ports":[80,8123]},
		{"cidr":"192.168.1.10/32","ports":[8123,9000]},
		{"cidr":"fd12:3456:789a::/48","ports":[8123]},
		{"cidr":"fd12:3456:789a:1::/64","ports":[8123]}]}`)
	write(t, filepath.Join(d, "one.nft"), testSets.Script(v4, v6), 0o644)
	v4, v6 = elements(t, `{"version":1,"networks":[{"cidr":"10.1.0.0/16","ports":[443]}]}`)
	write(t, filepath.Join(d, "two.nft"), testSets.Script(v4, v6), 0o644)
	write(t, filepath.Join(d, "empty.nft"), testSets.Script(nil, nil), 0o644)

	out := nftInNamespace(t, `
		cd `+d+`
		$NFT -f table.nft
		$NFT -f - < one.nft
		echo ONE; $NFT list set inet whombat-egress vault4; $NFT list set inet whombat-egress vault6
		$NFT -f - < two.nft
		echo TWO; $NFT list set inet whombat-egress vault4; $NFT list set inet whombat-egress vault6
		$NFT -f - < empty.nft
		echo EMPTY; $NFT list set inet whombat-egress vault4; $NFT list set inet whombat-egress vault6
	`)
	one := section(out, "ONE", "TWO")
	for _, want := range []string{"192.168.0.0/16 . 80", "192.168.1.0/24 . 8123", "192.168.1.10 . 9000", "fd12:3456:789a::/48 . 8123"} {
		if !strings.Contains(one, want) {
			t.Errorf("first list lacks %q:\n%s", want, one)
		}
	}
	for _, gone := range []string{"192.168.1.0/24 . 80", "192.168.1.10 . 8123", "fd12:3456:789a:1::/64"} {
		if strings.Contains(one, gone) {
			t.Errorf("first list has the covered %q:\n%s", gone, one)
		}
	}
	two := section(out, "TWO", "EMPTY")
	if !strings.Contains(two, "10.1.0.0/16 . 443") || strings.Contains(two, "192.168") || strings.Contains(two, "fd12") {
		t.Errorf("second list:\n%s", two)
	}
	if empty := section(out, "EMPTY", ""); strings.Contains(empty, "elements") {
		t.Errorf("not emptied:\n%s", empty)
	}
}

func section(out, from, to string) string {
	i := strings.Index(out, from)
	if i < 0 {
		return ""
	}
	out = out[i:]
	if to != "" {
		if j := strings.Index(out, to); j >= 0 {
			out = out[:j]
		}
	}
	return out
}

// A failing transaction is reported with nft's message.
func TestNFTApplyError(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	fake := filepath.Join(t.TempDir(), "nft")
	write(t, fake, "#!"+sh+"\ncat >/dev/null; echo 'Error: No such file or directory' >&2; exit 1\n", 0o755)
	err = NFT{Path: fake}.Apply(testSets.Script(nil, nil))
	if err == nil || !strings.Contains(err.Error(), "No such file or directory") {
		t.Fatalf("%v", err)
	}
	ok := filepath.Join(t.TempDir(), "nft")
	write(t, ok, "#!"+sh+"\n[ \"$1 $2\" = '-f -' ] && grep -q '^flush set inet whombat-egress vault6$'\n", 0o755)
	if err := (NFT{Path: ok}).Apply(testSets.Script(nil, nil)); err != nil {
		t.Fatal(err)
	}
}
