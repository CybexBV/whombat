package diagnose

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
)

// Redacted replaces a secret.
const Redacted = "<redacted>"

// secretKey matches keys whose values are secrets: passwords, tokens,
// keys, Unraid's csrf_token, cloud-init's cipassword.
var secretKey = regexp.MustCompile(`(?i)(pass(word|wd)?|secret|token|api[_-]?key|private|csrf|cipassword|credential)`)

var (
	// key = value, key="value", key: value (INI, qm / pct config, YAML-ish).
	kvLine = regexp.MustCompile(`^(\s*[-"']?)([A-Za-z0-9_.\[\]-]+)(["']?\s*[=:]\s*)(.*)$`)
	// KEY=value inside a line (lxc.environment: PASSWORD=x, --db-password=x,
	// ?token=x in a URL).
	inlineKV = regexp.MustCompile(`([A-Za-z0-9_.-]+)=("[^"]*"|'[^']*'|[^\s,;&"']+)`)
	// user:password@ in a URL.
	urlUserinfo = regexp.MustCompile(`(://[^/\s:@]+:)[^@\s/]+@`)
	// a command-line flag whose next argument is a secret (--password x).
	secretFlag = regexp.MustCompile(`^-{1,2}[A-Za-z0-9_.-]*$`)
)

// redactConfig hides the values of secret-looking keys in configuration
// output, line by line.
func redactConfig(s string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = redactLine(l)
	}
	return strings.Join(lines, "\n")
}

func redactLine(l string) string {
	if m := kvLine.FindStringSubmatch(l); m != nil && secretKey.MatchString(m[2]) && strings.TrimSpace(m[4]) != "" {
		v := strings.TrimSpace(m[4])
		repl := Redacted
		if q := v[0]; (q == '"' || q == '\'') && len(v) > 1 && v[len(v)-1] == q {
			repl = string(q) + Redacted + string(q)
		}
		return m[1] + m[2] + m[3] + repl
	}
	return redactInline(l)
}

// redactInline hides KEY=value pairs with secret-looking keys and URL
// passwords inside free text.
func redactInline(s string) string {
	if strings.IndexByte(s, '=') >= 0 {
		s = inlineKV.ReplaceAllStringFunc(s, func(kv string) string {
			k, v, _ := strings.Cut(kv, "=")
			if !secretKey.MatchString(k) {
				return kv
			}
			if len(v) > 1 && (v[0] == '"' || v[0] == '\'') {
				return k + "=" + string(v[0]) + Redacted + string(v[0])
			}
			return k + "=" + Redacted
		})
	}
	if strings.Contains(s, "://") {
		s = urlUserinfo.ReplaceAllString(s, "${1}"+Redacted+"@")
	}
	return s
}

// redactArgs hides secrets on a command line: --password=x, and the
// argument after a secret-looking flag (--password x, -p is not guessed).
func redactArgs(cmdline string) string {
	f := strings.Split(cmdline, " ")
	for i := range f {
		f[i] = redactInline(f[i])
		if i > 0 && isSecretFlag(f[i-1]) && f[i] != "" && !strings.HasPrefix(f[i], "-") {
			f[i] = Redacted
		}
	}
	return strings.Join(f, " ")
}

func isSecretFlag(a string) bool { return secretFlag.MatchString(a) && secretKey.MatchString(a) }

// redactJSON redacts a decoded JSON value in place: values of secret
// keys, KEY=value pairs in strings and the argument after a secret flag in
// string lists.
func redactJSON(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for k, e := range t {
			if secretKey.MatchString(k) {
				switch e.(type) {
				case string, json.Number, bool:
					t[k] = Redacted
					continue
				}
			}
			t[k] = redactJSON(e)
		}
	case []any:
		for i, e := range t {
			if s, ok := e.(string); ok && i > 0 {
				if p, ok := t[i-1].(string); ok && isSecretFlag(p) && !strings.HasPrefix(s, "-") {
					t[i] = Redacted
					continue
				}
			}
			t[i] = redactJSON(e)
		}
	case string:
		return redactInline(t)
	}
	return v
}

// dockerInspect turns `docker container inspect` output into what the
// assistant may see: Config.Env removed (containers' environment is never
// returned), secrets redacted, indented.
func dockerInspect(b []byte) (string, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var v []any
	if err := dec.Decode(&v); err != nil {
		return "", err
	}
	for _, c := range v {
		if m, ok := c.(map[string]any); ok {
			if cfg, ok := m["Config"].(map[string]any); ok {
				delete(cfg, "Env")
			}
		}
	}
	var out strings.Builder
	enc := json.NewEncoder(&out)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(redactJSON(v)); err != nil {
		return "", err
	}
	return "(Config.Env, the container's environment, is never shown)\n" + out.String(), nil
}
