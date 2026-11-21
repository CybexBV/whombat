package broker

import (
	"context"
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rackoon/internal/proto"
)

// unraidPlace is a backup place on the fake Unraid: emcmd makes and
// changes shares in /boot/config/shares the way emhttp would (a new share
// is exported over SMB, as on older Unraid releases).
func unraidPlace(t *testing.T) (*unraidFixture, *placeFixture) {
	t.Helper()
	u := newUnraidFixture(t)
	u.write("var/local/emhttp/var.ini", strings.Replace(unraidVarStopped, `mdState="STOPPED"`, `mdState="STARTED"`, 1)+
		"shareNFSEnabled=\"yes\"\nSYS_ARRAY_SLOTS=\"24\"\n")
	bin := filepath.Join(u.root, "bin")
	u.script(bin, "emcmd", fmt.Sprintf(`root=%[1]s
name=$(printf '%%s' "$1" | sed -n 's/.*shareName=\([^&]*\).*/\1/p')
cfg="$root/boot/config/shares/$name.cfg"
arg() { printf '%%s' "$1" | sed -n "s/.*$2=\([^&]*\).*/\1/p" | sed 's/+/ /g; s/%%28/(/g; s/%%29/)/g; s/%%2C/,/g; s/%%3D/=/g'; }
case "$1" in
*cmdEditShare=*) mkdir -p "$root/boot/config/shares" "$root/mnt/user/$name"
  printf 'shareComment="x"\nshareExport="e"\nshareSecurity="public"\nshareExportNFS="-"\nshareSecurityNFS="public"\nshareHostListNFS=""\n' > "$cfg" ;;
*changeShareSecurity=*) sed -i 's/^shareExport=.*/shareExport="-"/' "$cfg" ;;
*changeShareSecurityNFS=*) e=$(arg "$1" shareExportNFS); s=$(arg "$1" shareSecurityNFS)
  sed -i "s/^shareExportNFS=.*/shareExportNFS=\"$e\"/; s/^shareSecurityNFS=.*/shareSecurityNFS=\"$s\"/" "$cfg" ;;
*changeShareAccessNFS=*) h=$(arg "$1" shareHostListNFS); grep -v '^shareHostListNFS=' "$cfg" > "$cfg.t"
  echo "shareHostListNFS=\"$h\"" >> "$cfg.t"; mv "$cfg.t" "$cfg" ;;
esac`, u.root))
	u.m.bins["emcmd"] = filepath.Join(bin, "emcmd")
	p := newPlaceFixture(t)
	p.m.unraid = u.m
	p.m.isUnraid = func() bool { return true }
	// The roots are below the fake /mnt/user, as on Unraid.
	p.m.root, p.m.userShares = "", filepath.Join(u.root, "mnt/user")
	p.root = filepath.Join(p.m.userShares, proto.PlaceShareName)
	return u, p
}

func emcmdCalls(u *unraidFixture) []string {
	var out []string
	for _, c := range u.calls() {
		if s, ok := strings.CutPrefix(c, "emcmd "); ok {
			out = append(out, s)
		}
	}
	return out
}

func TestPlaceUnraid(t *testing.T) {
	u, f := unraidPlace(t)
	ctx := context.Background()
	res, err := f.ensure("whombat-home-4hxx", testRestPW, 0)
	if err != nil || res.Port != 8747 {
		t.Fatalf("ensure = %+v %v", res, err)
	}
	calls := emcmdCalls(u)
	if len(calls) != 2 {
		t.Fatalf("emcmd calls = %q", calls)
	}
	if calls[0] != "shareNameOrig=&shareUseCache=no&shareCachePool2=&shareAllocator=highwater&shareSplitLevel=&shareInclude=&shareExclude="+
		"&shareName=whombat-backups&shareComment=Whombat%E2%80%99s+backups&shareFloor=&shareCachePool=&shareCOW=auto&cmdEditShare=Add+Share" {
		t.Errorf("add share = %q", calls[0])
	}
	if calls[1] != "shareName=whombat-backups&shareExport=-&shareVolsizelimit=&shareCaseSensitive=auto&shareSecurity=public&changeShareSecurity=Apply" {
		t.Errorf("smb off = %q", calls[1])
	}
	cfg := u.read("boot/config/shares/whombat-backups.cfg")
	if !strings.Contains(cfg, `shareExport="-"`) || !strings.Contains(cfg, `shareExportNFS="-"`) {
		t.Errorf("share = %s", cfg)
	}
	tmpl := u.read("boot/config/plugins/dockerMan/templates-user/my-whombat-backup-whombat-home-4hxx.xml")
	var x struct {
		Name, Repository, Network, ExtraParams, PostArgs string
		Config                                           []struct {
			Name   string `xml:"Name,attr"`
			Target string `xml:"Target,attr"`
			Mode   string `xml:"Mode,attr"`
			Value  string `xml:",chardata"`
		}
	}
	if err := xml.Unmarshal([]byte(tmpl), &x); err != nil {
		t.Fatalf("template: %v\n%s", err, tmpl)
	}
	if x.Name != "whombat-backup-whombat-home-4hxx" || x.Repository != PlaceRestImage || x.Network != "bridge" ||
		!strings.Contains(x.ExtraParams, "--entrypoint=/usr/bin/rest-server") || !strings.Contains(x.ExtraParams, "--restart=unless-stopped") ||
		!strings.Contains(x.ExtraParams, "--tmpfs=/data:") || !strings.Contains(x.ExtraParams, "--label=whombat.client=whombat-home-4hxx") ||
		strings.Contains(x.ExtraParams, "net.unraid") || !strings.Contains(x.PostArgs, "--append-only --private-repos") || len(x.Config) != 4 ||
		x.Config[0].Name != "Port" || x.Config[0].Value != "8747" || x.Config[2].Mode != "ro" ||
		x.Config[3].Target != "/data/kit" || x.Config[3].Mode != "rw" || x.Config[3].Name == x.Config[1].Name {
		t.Errorf("template = %+v", x)
	}
	if c := f.d.ctr("whombat-backup-whombat-home-4hxx"); c.spec.Labels["net.unraid.docker.managed"] != "dockerman" {
		t.Errorf("labels = %v", c.spec.Labels)
	}
	if a := u.read("var/lib/docker/unraid-autostart"); !strings.Contains(a, "whombat-backup-whombat-home-4hxx\n") || !strings.Contains(a, "plex\n") {
		t.Errorf("autostart = %q", a)
	}
	// Again: the share is as it should be, emcmd isn't called.
	if _, err := f.ensure("whombat-home-4hxx", testRestPW, 0); err != nil || len(emcmdCalls(u)) != 2 {
		t.Errorf("again: %v %q", err, emcmdCalls(u))
	}
	if _, err := f.m.setCleanup(ctx, &proto.PlaceRequest{Client: "whombat-home-4hxx", RepositoryPassword: "pw"}); err != nil {
		t.Fatal(err)
	}
	ct := u.read("boot/config/plugins/dockerMan/templates-user/my-whombat-backup-whombat-home-4hxx-cleanup.xml")
	if !strings.Contains(ct, "<Network>none</Network>") || !strings.Contains(ct, "<PostArgs>/state/cleanup.sh whombat-home-4hxx 90</PostArgs>") ||
		!strings.Contains(ct, "--entrypoint=/bin/sh") {
		t.Errorf("cleanup template = %s", ct)
	}
	if _, err := f.m.remove(ctx, &proto.PlaceRequest{Client: "whombat-home-4hxx"}); err != nil {
		t.Fatal(err)
	}
	if a := u.read("var/lib/docker/unraid-autostart"); strings.Contains(a, "whombat") || !strings.Contains(a, "plex") {
		t.Errorf("autostart after remove = %q", a)
	}
	if ents, _ := os.ReadDir(filepath.Join(u.root, "boot/config/plugins/dockerMan/templates-user")); len(ents) != 1 {
		t.Errorf("templates left: %v", ents)
	}

	bp := f.m.status(ctx)
	if !bp.Supported || bp.Platform != proto.PlacePlatformUnraid || !bp.NFS {
		t.Errorf("status = %+v", bp)
	}
	u.write("var/local/emhttp/var.ini", unraidVarStopped)
	if bp := f.m.status(ctx); bp.Supported || bp.Reason != proto.PlaceArrayStopped {
		t.Errorf("stopped = %+v", bp)
	}
	if _, err := f.ensure("whombat-home-4hxx", testRestPW, 0); placeFailure(err).Place.Reason != proto.PlaceArrayStopped {
		t.Errorf("ensure while stopped: %v", err)
	}
}

func TestPlaceUnraidPoolsOnly(t *testing.T) {
	u, f := unraidPlace(t)
	u.write("var/local/emhttp/var.ini", strings.Replace(unraidVarStopped, `mdState="STOPPED"`, `mdState="STARTED"`, 1)+"SYS_ARRAY_SLOTS=\"0\"\n")
	u.write("boot/config/pools/zcache.cfg", "")
	u.write("boot/config/pools/apps.cfg", "")
	if _, err := f.ensure("whombat-home-4hxx", testRestPW, 0); err != nil {
		t.Fatal(err)
	}
	if c := emcmdCalls(u)[0]; !strings.Contains(c, "shareUseCache=only&") || !strings.Contains(c, "&shareCachePool=apps&") {
		t.Errorf("add share = %q", c)
	}
}

func TestPlaceUnraidNFS(t *testing.T) {
	u, f := unraidPlace(t)
	ctx := context.Background()
	nfs := func(name string, clients ...string) (proto.PlaceResult, error) {
		return f.m.nfsShare(ctx, &proto.PlaceRequest{Name: name, Clients: clients})
	}
	res, err := nfs("whombat-pve-01", "10.100.1.5")
	if err != nil || res.Export != "/mnt/user/whombat-pve-01" || len(res.Addresses) != 2 {
		t.Fatalf("nfs = %+v %v", res, err)
	}
	calls := emcmdCalls(u)
	if len(calls) != 4 || !strings.Contains(calls[0], "shareName=whombat-pve-01&shareComment=") ||
		calls[2] != "shareName=whombat-pve-01&shareExportNFS=e&shareSecurityNFS=private&changeShareSecurityNFS=Apply" ||
		calls[3] != "shareName=whombat-pve-01&shareHostListNFS=10.100.1.5%28sec%3Dsys%2Crw%2Cno_root_squash%29&changeShareAccessNFS=Apply" {
		t.Fatalf("emcmd = %q", calls)
	}
	// Another address is added; the first rule stays.
	if _, err := nfs("whombat-pve-01", "10.100.1.6", "10.100.1.5"); err != nil {
		t.Fatal(err)
	}
	calls = emcmdCalls(u)
	if len(calls) != 5 || !strings.Contains(u.read("boot/config/shares/whombat-pve-01.cfg"),
		`shareHostListNFS="10.100.1.5(sec=sys,rw,no_root_squash) 10.100.1.6(sec=sys,rw,no_root_squash)"`) {
		t.Errorf("second = %q\n%s", calls, u.read("boot/config/shares/whombat-pve-01.cfg"))
	}
	// Nothing new: nothing is sent.
	if _, err := nfs("whombat-pve-01", "10.100.1.6"); err != nil || len(emcmdCalls(u)) != 5 {
		t.Errorf("same again: %v %q", err, emcmdCalls(u))
	}
	for _, bad := range []struct {
		name    string
		clients []string
		field   string
	}{{"media", []string{"10.100.1.5"}, "name"}, {"whombat-backups", []string{"10.100.1.5"}, "name"},
		{"whombat-pve-02", nil, "clients"}, {"whombat-pve-02", []string{"pve-02.lan"}, "clients"}, {"whombat-pve-02", []string{"127.0.0.1"}, "clients"}} {
		if _, err := nfs(bad.name, bad.clients...); placeFailure(err).FieldErrors[bad.field] == "" {
			t.Errorf("%+v: %v", bad, err)
		}
	}
	u.write("var/local/emhttp/var.ini", strings.Replace(unraidVarStopped, `mdState="STOPPED"`, `mdState="STARTED"`, 1)+"shareNFSEnabled=\"no\"\n")
	if _, err := nfs("whombat-pve-02", "10.100.1.7"); placeFailure(err).Place.Reason != proto.PlaceNFSOff {
		t.Errorf("nfs off: %v", err)
	}
}

func TestMergeNFSRules(t *testing.T) {
	got, changed := mergeNFSRules("10.0.0.1(rw) *(ro)", []string{"10.0.0.1", "10.0.0.2"})
	if !changed || got != "10.0.0.1(rw) *(ro) 10.0.0.2(sec=sys,rw,no_root_squash)" {
		t.Errorf("merge = %q %v", got, changed)
	}
	if _, changed := mergeNFSRules("10.0.0.1(rw)", []string{"10.0.0.1"}); changed {
		t.Error("changed without a new client")
	}
}
