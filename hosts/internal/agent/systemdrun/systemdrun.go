// Package systemdrun keeps a command's words as they are when the agent runs
// it in a transient service through systemd-run.
package systemdrun

import "strings"

// Literal returns args with every "$" doubled. systemd reads a transient
// service's command line the way it reads ExecStart=: "${NAME}" (and "$NAME"
// as a word of its own) becomes a variable of the unit's environment, and
// "$$" becomes "$", so a shell command such as `echo "${f}" $$` would lose
// its variables. Doubling every "$" hands the command over unchanged on every
// systemd version; systemd-run's --expand-environment=no would too, but only
// from systemd 254.
func Literal(args ...string) []string {
	out := make([]string, len(args))
	for i, a := range args {
		out[i] = strings.ReplaceAll(a, "$", "$$")
	}
	return out
}
