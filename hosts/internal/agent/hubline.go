package agent

import (
	"bytes"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

	"github.com/pelletier/go-toml/v2"
)

// The agent saves a hub address it found (HS-175) by rewriting only the
// hub = … line of agent.toml: every other byte (comments, the owner's
// switches, their order) stays, and so do the file's mode and owner. The
// result is parsed again and must differ from the file in hub alone.

// hubLineRE matches a top-level hub key: indentation, key, " = ", the rest.
var hubLineRE = regexp.MustCompile(`^([ \t]*)(hub|"hub"|'hub')([ \t]*=[ \t]*)(.*)$`)

// tableRE matches a table header ([pve], [[x]], [a."b"]), which ends the
// root table.
var tableRE = regexp.MustCompile(`^[ \t]*\[\[?[ \t]*[A-Za-z0-9_\-."' ]+\]\]?[ \t]*(#.*)?$`)

// replaceHubLine returns content with the root table's hub value replaced by
// url (a line hub = "url" at the top when there is none).
func replaceHubLine(content []byte, url string) ([]byte, error) {
	if strings.ContainsAny(url, "\"\\\n\r") {
		return nil, fmt.Errorf("unusable hub address %q", url)
	}
	quoted := `"` + url + `"`
	lines := bytes.SplitAfter(content, []byte("\n"))
	for i, raw := range lines {
		body := bytes.TrimRight(raw, "\r\n")
		eol := raw[len(body):]
		if tableRE.Match(body) {
			break
		}
		m := hubLineRE.FindSubmatch(body)
		if m == nil {
			continue
		}
		rest, ok := afterTOMLString(string(m[4]))
		if !ok {
			return nil, errors.New("the hub line is not a plain string")
		}
		var b bytes.Buffer
		b.Write(m[1])
		b.Write(m[2])
		b.Write(m[3])
		b.WriteString(quoted)
		b.WriteString(rest)
		b.Write(eol)
		lines[i] = b.Bytes()
		return bytes.Join(lines, nil), nil
	}
	eol := "\n"
	if bytes.Contains(content, []byte("\r\n")) {
		eol = "\r\n"
	}
	return append([]byte("hub = "+quoted+eol), content...), nil
}

// afterTOMLString returns what follows a one-line TOML string at the start
// of s (whitespace and a comment).
func afterTOMLString(s string) (string, bool) {
	if strings.HasPrefix(s, `"""`) || strings.HasPrefix(s, "'''") {
		return "", false
	}
	switch {
	case strings.HasPrefix(s, `"`):
		for i := 1; i < len(s); i++ {
			switch s[i] {
			case '\\':
				i++
			case '"':
				return s[i+1:], true
			}
		}
	case strings.HasPrefix(s, "'"):
		if j := strings.IndexByte(s[1:], '\''); j >= 0 {
			return s[j+2:], true
		}
	}
	return "", false
}

// checkHubRewrite parses both versions: the new one must have hub = url and
// everything else as before.
func checkHubRewrite(old, updated []byte, url string) error {
	var a, b map[string]any
	if err := toml.Unmarshal(old, &a); err != nil {
		return fmt.Errorf("%s: %w", ConfigFileName, err)
	}
	if err := toml.Unmarshal(updated, &b); err != nil {
		return fmt.Errorf("rewritten %s: %w", ConfigFileName, err)
	}
	if b["hub"] != url {
		return errors.New("the rewritten hub line did not take")
	}
	delete(a, "hub")
	delete(b, "hub")
	if !maps.EqualFunc(a, b, func(x, y any) bool { return fmt.Sprint(x) == fmt.Sprint(y) }) {
		return errors.New("rewriting the hub line changed other settings")
	}
	return nil
}

// RewriteHub sets the hub of the agent.toml at path to url, atomically,
// keeping the rest of the file and its mode and owner (a symlink's target
// is rewritten).
func RewriteHub(path, url string) error {
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	fi, err := os.Stat(real)
	if err != nil {
		return err
	}
	old, err := os.ReadFile(real)
	if err != nil {
		return err
	}
	updated, err := replaceHubLine(old, url)
	if err != nil {
		return err
	}
	if bytes.Equal(old, updated) {
		return nil
	}
	if err := checkHubRewrite(old, updated, url); err != nil {
		return err
	}
	dir := filepath.Dir(real)
	f, err := os.CreateTemp(dir, "."+filepath.Base(real)+".tmp*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp) // no-op after the rename
	// Mode and owner as before. Errors are ignored: a FAT flash drive
	// (Unraid) has neither, and a non-root agent can't give a file away.
	_ = f.Chmod(fi.Mode().Perm())
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		_ = f.Chown(int(st.Uid), int(st.Gid))
	}
	if _, err := f.Write(updated); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, real); err != nil {
		return err
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}
