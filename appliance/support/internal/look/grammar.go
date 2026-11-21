// Package look is the Look level of remote help (Whombat RH-02): a fixed list of read-only commands with a fixed
// argument grammar, run on fixed binaries as the unprivileged user whombat-support-look (never through a shell), plus
// reads from the manager. Everything a support person types is a command name and words this grammar accepts, or it
// is refused.
package look

import (
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/CybexBV/whombat/appliance/support/internal/wire"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// Bounds of the grammar.
const (
	MaxUnits      = 8
	MaxLines      = 10000
	DefaultLines  = 200
	MaxPattern    = 100
	maxLineBytes  = 2000
	maxWords      = 64
	unitMaxLength = 80
)

// Refusal is why a command line isn't run: Reason is wire.ReasonUnknownCommand or wire.ReasonBadArguments, Message
// says it to the support person.
type Refusal struct {
	Reason  string
	Message string
}

func (r *Refusal) Error() string { return r.Message }

func unknown(format string, args ...any) *Refusal {
	return &Refusal{Reason: wire.ReasonUnknownCommand, Message: fmt.Sprintf(format, args...)}
}

func badArgs(format string, args ...any) *Refusal {
	return &Refusal{Reason: wire.ReasonBadArguments, Message: fmt.Sprintf(format, args...)}
}

// Command is one Look command that passed the grammar.
type Command struct {
	Name   string   // one of wire.LookCommands
	Units  []string // the units named (status, logs), ≤ MaxUnits
	Line   string   // the arguments as typed, ≤ wire.CommandLineChars characters
	Follow bool     // logs -f: runs until the channel closes
	Failed bool     // units --failed
	argv   []string // logs: journalctl's arguments
}

// Step is the record of this command (kind look; its arguments, never its output). Only a logs step names its units
// (the contract's rule); status's units are in its line.
func (c Command) Step() wire.Step {
	s := wire.Step{Kind: wire.StepLook, Command: wire.Ptr(protocol.LookCommand(c.Name))}
	if c.Name == "logs" && len(c.Units) > 0 {
		s.Units = c.Units
	}
	if c.Line != "" {
		s.Line = wire.Ptr(c.Line)
	}
	return s
}

var (
	unitRe     = regexp.MustCompile(`^[A-Za-z0-9@._-]{1,80}$`)
	levelNames = `emerg|alert|crit|err|warning|notice|info|debug|[0-7]`
	priorityRe = regexp.MustCompile(`^(` + levelNames + `)(\.\.(` + levelNames + `))?$`)
	bootRe     = regexp.MustCompile(`^([-+]?[0-9]{1,4}|[0-9a-f]{32})$`)
	timeUnits  = `us|ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|month|months|y|year|years`
	timeRes    = []*regexp.Regexp{
		regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2})?)?( UTC)?$`),
		regexp.MustCompile(`^[0-9]{2}:[0-9]{2}(:[0-9]{2})?( UTC)?$`),
		regexp.MustCompile(`^@[0-9]{1,12}$`),
		regexp.MustCompile(`^(now|today|yesterday|tomorrow)$`),
		regexp.MustCompile(`^[-+][0-9]{1,6} ?(` + timeUnits + `)$`),
		regexp.MustCompile(`^[0-9]{1,6} ?(` + timeUnits + `) ago$`),
	}
)

// ValidUnit is the unit-name grammar: `^[A-Za-z0-9@._-]{1,80}$`, and never an option (a leading '-').
func ValidUnit(u string) bool {
	return len(u) <= unitMaxLength && unitRe.MatchString(u) && !strings.HasPrefix(u, "-")
}

// ValidTime is journalctl's time forms this grammar accepts for --since/--until.
func ValidTime(s string) bool {
	return slices.ContainsFunc(timeRes, func(re *regexp.Regexp) bool { return re.MatchString(s) })
}

// IsCommand reports whether name is a Look command.
func IsCommand(name string) bool { return slices.Contains(wire.LookCommands, name) }

// Split cuts a command line into words like a shell would, without expanding anything: blanks separate words,
// '…' is literal, "…" is literal except \" and \\, a backslash outside quotes takes the next character. Control
// characters, unbalanced quotes, invalid UTF-8 and lines above the bounds are refused.
func Split(line string) ([]string, error) {
	if len(line) > maxLineBytes {
		return nil, badArgs("That line is too long.")
	}
	if !utf8.ValidString(line) {
		return nil, badArgs("That line isn't text.")
	}
	var words []string
	var cur strings.Builder
	inWord := false
	quote := rune(0)
	escaped := false
	for _, r := range line {
		if r < 0x20 && r != '\t' || r == 0x7f {
			return nil, badArgs("That line has control characters.")
		}
		switch {
		case escaped:
			cur.WriteRune(r)
			escaped = false
		case quote == '\'':
			if r == '\'' {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case quote == '"':
			switch r {
			case '"':
				quote = 0
			case '\\':
				escaped = true
			default:
				cur.WriteRune(r)
			}
		case r == '\'' || r == '"':
			quote = r
			inWord = true
		case r == '\\':
			escaped = true
			inWord = true
		case r == ' ' || r == '\t':
			if inWord {
				words = append(words, cur.String())
				cur.Reset()
				inWord = false
			}
		default:
			cur.WriteRune(r)
			inWord = true
		}
	}
	if quote != 0 || escaped {
		return nil, badArgs("That line has an unfinished quote or backslash.")
	}
	if inWord {
		words = append(words, cur.String())
	}
	if len(words) > maxWords {
		return nil, badArgs("That line has too many words.")
	}
	return words, nil
}

// Truncate cuts s to n characters.
func Truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// Parse checks a command line against the grammar. A refusal is a *Refusal.
func Parse(line string) (Command, error) {
	words, err := Split(line)
	if err != nil {
		return Command{}, err
	}
	if len(words) == 0 {
		return Command{}, unknown("Type a Look command: %s.", strings.Join(wire.LookCommands, ", "))
	}
	name, args := words[0], words[1:]
	if !IsCommand(name) {
		return Command{}, unknown("“%s” isn't a Look command. Look commands: %s.", Truncate(name, 40),
			strings.Join(wire.LookCommands, ", "))
	}
	c := Command{Name: name}
	if len(args) > 0 {
		// The arguments as typed (quotes kept), or as words when the command name itself was quoted.
		rest := strings.Join(args, " ")
		if t := strings.TrimLeft(line, " \t"); strings.HasPrefix(t, name) {
			rest = strings.TrimSpace(t[len(name):])
		}
		c.Line = Truncate(rest, wire.CommandLineChars)
	}
	switch name {
	case "status":
		for _, a := range args {
			if !ValidUnit(a) {
				return Command{}, badArgs("“%s” isn't a unit name.", Truncate(a, 80))
			}
		}
		if len(args) > MaxUnits {
			return Command{}, badArgs("At most %d units at a time.", MaxUnits)
		}
		c.Units = args
	case "units":
		switch {
		case len(args) == 0:
		case len(args) == 1 && args[0] == "--failed":
			c.Failed = true
		default:
			return Command{}, badArgs("units takes only --failed.")
		}
	case "logs":
		if err := c.parseLogs(args); err != nil {
			return Command{}, err
		}
	default:
		if len(args) > 0 {
			return Command{}, badArgs("%s takes no arguments.", name)
		}
	}
	return c, nil
}

// parseLogs builds journalctl's arguments from the logs grammar.
func (c *Command) parseLogs(args []string) error {
	var lines, since, until, priority, boot, grep string
	var haveLines, haveSince, haveUntil, havePriority, haveBoot, haveGrep, kernel bool
	seen := map[string]bool{}
	once := func(flag string) error {
		if seen[flag] {
			return badArgs("%s is given twice.", flag)
		}
		seen[flag] = true
		return nil
	}
	// value takes the flag's value: `--x=v`, or the next word.
	for i := 0; i < len(args); i++ {
		a := args[i]
		flag, val, hasVal := a, "", false
		if strings.HasPrefix(a, "--") {
			if k, v, ok := strings.Cut(a, "="); ok {
				flag, val, hasVal = k, v, true
			}
		}
		next := func() (string, error) {
			if hasVal {
				return val, nil
			}
			if i+1 >= len(args) {
				return "", badArgs("%s needs a value.", flag)
			}
			i++
			return args[i], nil
		}
		switch flag {
		case "-u", "--unit":
			u, err := next()
			if err != nil {
				return err
			}
			if !ValidUnit(u) {
				return badArgs("“%s” isn't a unit name.", Truncate(u, 80))
			}
			c.Units = append(c.Units, u)
		case "-n", "--lines":
			if err := once("-n"); err != nil {
				return err
			}
			v, err := next()
			if err != nil {
				return err
			}
			n, perr := strconv.Atoi(v)
			if perr != nil || n < 1 || n > MaxLines || strconv.Itoa(n) != v {
				return badArgs("-n takes a number from 1 to %d.", MaxLines)
			}
			lines, haveLines = v, true
		case "-S", "--since", "-U", "--until":
			key := "--since"
			if flag == "-U" || flag == "--until" {
				key = "--until"
			}
			if err := once(key); err != nil {
				return err
			}
			v, err := next()
			if err != nil {
				return err
			}
			if !ValidTime(v) {
				return badArgs("%s takes a time like 2026-10-21, \"2026-10-21 14:00\", 14:00, -2h, \"1 hour ago\" or yesterday.", key)
			}
			v = strings.Replace(v, "T", " ", 1)
			if key == "--since" {
				since, haveSince = v, true
			} else {
				until, haveUntil = v, true
			}
		case "-p", "--priority":
			if err := once("-p"); err != nil {
				return err
			}
			v, err := next()
			if err != nil {
				return err
			}
			if !priorityRe.MatchString(v) {
				return badArgs("-p takes a priority (emerg, alert, crit, err, warning, notice, info, debug or 0–7) or a range like err..warning.")
			}
			priority, havePriority = v, true
		case "-f", "--follow":
			if hasVal {
				return badArgs("-f takes no value.")
			}
			if err := once("-f"); err != nil {
				return err
			}
			c.Follow = true
		case "-k", "--dmesg":
			if hasVal {
				return badArgs("-k takes no value.")
			}
			if err := once("-k"); err != nil {
				return err
			}
			kernel = true
		case "-b", "--boot":
			if err := once("-b"); err != nil {
				return err
			}
			switch {
			case hasVal:
				boot = val
			case i+1 < len(args) && bootRe.MatchString(args[i+1]):
				i++
				boot = args[i]
			}
			if boot != "" && !bootRe.MatchString(boot) {
				return badArgs("-b takes a boot offset like 0 or -1, or a boot id.")
			}
			haveBoot = true
		case "-g", "--grep":
			if err := once("-g"); err != nil {
				return err
			}
			v, err := next()
			if err != nil {
				return err
			}
			if v == "" || utf8.RuneCountInString(v) > MaxPattern {
				return badArgs("-g takes a pattern of 1 to %d characters.", MaxPattern)
			}
			grep, haveGrep = v, true
		default:
			if strings.HasPrefix(a, "-") {
				return badArgs("logs doesn't take %s. Try: logs [UNIT…] [-n N] [--since T] [--until T] [-p PRIORITY] [-k] [-b [N]] [-g PATTERN] [-f]", Truncate(a, 40))
			}
			if !ValidUnit(a) {
				return badArgs("“%s” isn't a unit name.", Truncate(a, 80))
			}
			c.Units = append(c.Units, a)
		}
	}
	if len(c.Units) > MaxUnits {
		return badArgs("At most %d units at a time.", MaxUnits)
	}
	if !haveLines {
		lines = strconv.Itoa(DefaultLines)
		if haveSince || haveUntil || haveBoot {
			lines = strconv.Itoa(MaxLines)
		}
	}
	argv := []string{"--no-pager", "-o", "short-iso", "--lines=" + lines}
	if haveSince {
		argv = append(argv, "--since="+since)
	}
	if haveUntil {
		argv = append(argv, "--until="+until)
	}
	if havePriority {
		argv = append(argv, "--priority="+priority)
	}
	if kernel {
		argv = append(argv, "--dmesg")
	}
	if haveBoot {
		if boot == "" {
			argv = append(argv, "--boot")
		} else {
			argv = append(argv, "--boot="+boot)
		}
	}
	if haveGrep {
		argv = append(argv, "--grep="+grep)
	}
	if c.Follow {
		argv = append(argv, "--follow")
	}
	for _, u := range c.Units {
		argv = append(argv, "--unit="+u)
	}
	c.argv = argv
	return nil
}

// Help is the list of Look commands.
func Help() string {
	return `Look commands (read only; nothing here changes the box):
  help                      this list
  status [UNIT…]            how the box is doing, or the status of these units
  units [--failed]          every unit, or only the failed ones
  logs [UNIT…] [-n N] [--since T] [--until T] [-p PRIORITY] [-k] [-b [N]] [-g PATTERN] [-f]
                            the journal: the last 200 lines unless -n says (up to 10000); -f follows it
  boots                     the boots the journal knows
  hardware                  the hardware report
  network                   the network state, addresses and routes
  disks                     file systems and block devices
  memory                    memory, swap and pressure
  processes                 running programs (names only)
  updates                   the update status
  report                    one report of the units, the system, the journal and the network
Times for --since/--until: 2026-10-21, "2026-10-21 14:00", 14:00, -2h, "1 hour ago", yesterday, today, now, @1792000000.
`
}
