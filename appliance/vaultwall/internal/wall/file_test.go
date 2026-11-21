package wall

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

const valid = `{"version":1,"networks":[{"cidr":"192.168.1.0/24","ports":[8123]}]}`

// dir makes a directory like /run/whombat-vault (0755, owned by the test's uid) and a Source for it.
func dir(t *testing.T) (string, Source) {
	t.Helper()
	d := filepath.Join(t.TempDir(), "whombat-vault")
	if err := os.Mkdir(d, 0o755); err != nil {
		t.Fatal(err)
	}
	src, err := NewSource(filepath.Join(d, "networks.json"), uint32(os.Getuid()), 1024)
	if err != nil {
		t.Fatal(err)
	}
	return d, src
}

func write(t *testing.T, path, data string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(data), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func TestNewSource(t *testing.T) {
	s, err := NewSource("/run/whombat-vault/networks.json", 951, 10)
	if err != nil || s.Dir != "/run/whombat-vault" || s.Name != "networks.json" || s.Path() != "/run/whombat-vault/networks.json" {
		t.Fatalf("%+v %v", s, err)
	}
	for _, bad := range []string{"", "networks.json", "run/x", "/run/whombat-vault/", "/run/../etc/x", "/run//x", "/"} {
		if _, err := NewSource(bad, 951, 10); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestReadRegularFile(t *testing.T) {
	d, src := dir(t)
	write(t, filepath.Join(d, "networks.json"), valid, 0o644)
	data, err := src.Read()
	if err != nil || string(data) != valid {
		t.Fatalf("%q %v", data, err)
	}
	// 0600 and 0640 are fine too: only writes by others are refused.
	write(t, filepath.Join(d, "networks.json"), valid, 0o600)
	if _, err := src.Read(); err != nil {
		t.Fatal(err)
	}
}

func TestReadMissing(t *testing.T) {
	d, src := dir(t)
	if _, err := src.Read(); !errors.Is(err, ErrNoFile) {
		t.Fatalf("missing file: %v", err)
	}
	if err := os.Remove(d); err != nil {
		t.Fatal(err)
	}
	if _, err := src.Read(); !errors.Is(err, ErrNoFile) {
		t.Fatalf("missing directory: %v", err)
	}
}

func refused(t *testing.T, src Source, want string) {
	t.Helper()
	data, err := src.Read()
	if err == nil {
		t.Fatalf("read %q", data)
	}
	if errors.Is(err, ErrNoFile) || !strings.Contains(err.Error(), want) {
		t.Fatalf("error %v, want %q", err, want)
	}
}

func TestReadNeverFollowsSymlinks(t *testing.T) {
	d, src := dir(t)
	outside := filepath.Join(t.TempDir(), "elsewhere.json")
	write(t, outside, valid, 0o644)

	// The file is a link (to a valid list elsewhere, or dangling).
	if err := os.Symlink(outside, filepath.Join(d, "networks.json")); err != nil {
		t.Fatal(err)
	}
	refused(t, src, "symbolic link")
	os.Remove(filepath.Join(d, "networks.json"))
	if err := os.Symlink("/nonexistent", filepath.Join(d, "networks.json")); err != nil {
		t.Fatal(err)
	}
	refused(t, src, "symbolic link")
	os.Remove(filepath.Join(d, "networks.json"))
	if err := os.Symlink(".", filepath.Join(d, "networks.json")); err != nil {
		t.Fatal(err)
	}
	refused(t, src, "symbolic link")

	// A directory in the path is a link.
	other := t.TempDir()
	if err := os.Chmod(other, 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(other, "networks.json"), valid, 0o644)
	link := filepath.Join(t.TempDir(), "whombat-vault")
	if err := os.Symlink(other, link); err != nil {
		t.Fatal(err)
	}
	viaLink, _ := NewSource(filepath.Join(link, "networks.json"), src.Owner, src.Max)
	refused(t, viaLink, "symbolic link")

	// A link higher up the path.
	if err := os.Mkdir(filepath.Join(other, "whombat-vault"), 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(other, "whombat-vault", "networks.json"), valid, 0o644)
	below, _ := NewSource(filepath.Join(link, "whombat-vault", "networks.json"), src.Owner, src.Max)
	refused(t, below, "symbolic link")
	direct, _ := NewSource(filepath.Join(other, "whombat-vault", "networks.json"), src.Owner, src.Max)
	if _, err := direct.Read(); err != nil {
		t.Fatalf("the same file without the link: %v", err)
	}
}

func TestReadRefusesOtherKinds(t *testing.T) {
	d, src := dir(t)
	p := filepath.Join(d, "networks.json")
	if err := os.Mkdir(p, 0o755); err != nil {
		t.Fatal(err)
	}
	refused(t, src, "not a regular file")
	os.Remove(p)

	// A FIFO must not block the reader.
	if err := syscall.Mkfifo(p, 0o644); err != nil {
		t.Fatal(err)
	}
	refused(t, src, "not a regular file")
	os.Remove(p)

	// A hard link from elsewhere is still a regular file with its owner's mode; the owner and mode checks apply.
	write(t, p, valid, 0o666)
	refused(t, src, "writable by others")
	write(t, p, valid, 0o664)
	refused(t, src, "writable by others")
	write(t, p, valid, 0o644)

	// A too large file.
	write(t, p, valid+strings.Repeat(" ", int(src.Max)), 0o644)
	refused(t, src, "larger than")
}

func TestReadChecksTheDirectory(t *testing.T) {
	d, src := dir(t)
	write(t, filepath.Join(d, "networks.json"), valid, 0o644)
	if err := os.Chmod(d, 0o777); err != nil {
		t.Fatal(err)
	}
	refused(t, src, "writable by others")
	if err := os.Chmod(d, 0o1777); err != nil {
		t.Fatal(err)
	}
	refused(t, src, "writable by others")
	if err := os.Chmod(d, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := src.Read(); err != nil {
		t.Fatal(err)
	}
	// The directory path names a file.
	notDir, _ := NewSource(filepath.Join(d, "networks.json", "x"), src.Owner, src.Max)
	if _, err := notDir.Read(); err == nil || errors.Is(err, ErrNoFile) {
		t.Fatalf("file as directory: %v", err)
	}
}

func TestReadChecksTheOwner(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root owns everything it creates, and root is always allowed")
	}
	d, src := dir(t)
	write(t, filepath.Join(d, "networks.json"), valid, 0o644)
	src.Owner = uint32(os.Getuid()) + 1
	refused(t, src, "owned by uid")
}
