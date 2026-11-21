package screen

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
)

// Start is why a box's first start can't finish (CG-409): the provisioning unit writes it when recording the release
// the box was installed with fails (nix/modules/provisioning.nix, NX-526), and removes it once that worked. It is shown
// on the starting screen only: an unclaimed box's runtime says it is starting until the manager first speaks, so a box
// whose manager never started shows it whether or not its runtime runs; any other screen means the box got further.
type Start struct {
	Problem string // StartReleaseMissing, StartOffline or StartFailed
	Release string // the release the box was installed with ("" when the file named none, or none the screen shows)
}

// The problems the provisioning unit names.
const (
	StartReleaseMissing = "release-missing" // no update channel lists the box's release
	StartOffline        = "offline"         // the update repository can't be read
	StartFailed         = "failed"          // anything else
)

// The start problem's words (CG-409). The title takes the place of “Starting Whombat…”; the last line is the same for
// every problem.
const (
	wordStartTitle              = "Whombat can’t start yet"
	wordStartReleaseMissing     = "This Whombat can’t find its version, %s, on the update server. Install it again with the newest Whombat installer."
	wordStartReleaseMissingNoID = "This Whombat can’t find its version on the update server. Install it again with the newest Whombat installer."
	wordStartOffline            = "This Whombat can’t reach the update server. Check the network cable."
	wordStartFailed             = "Something went wrong while this Whombat set itself up."
	wordStartRetry              = "It tries again by itself. To try now, restart it."
)

// MaxStartFileSize bounds what is read from the start problem file.
const MaxStartFileSize = 1024

// A release id as release ids are (contracts ReleaseID: lower case, digits, dots and dashes), short enough for a line.
var startReleaseRe = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{0,63}$`)

// ParseStart validates the start problem file: {"v": 1, "problem": "…", "release": "…"}. An unknown problem is refused
// (the screen then says only that it is starting); a release the screen wouldn't show is dropped.
func ParseStart(data []byte) (*Start, error) {
	if len(data) > MaxStartFileSize {
		return nil, errors.New("start file too large")
	}
	var f struct {
		V       int    `json:"v"`
		Problem string `json:"problem"`
		Release string `json:"release"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, err
	}
	if f.V != 1 {
		return nil, fmt.Errorf("start file: version %d", f.V)
	}
	switch f.Problem {
	case StartReleaseMissing, StartOffline, StartFailed:
	default:
		return nil, fmt.Errorf("start file: unknown problem %q", f.Problem)
	}
	s := &Start{Problem: f.Problem}
	if startReleaseRe.MatchString(f.Release) {
		s.Release = f.Release
	}
	return s, nil
}

// StartWords is what the screen says about the problem, after its title.
func StartWords(s *Start) string {
	switch s.Problem {
	case StartReleaseMissing:
		if s.Release == "" {
			return wordStartReleaseMissingNoID
		}
		return fmt.Sprintf(wordStartReleaseMissing, s.Release)
	case StartOffline:
		return wordStartOffline
	default:
		return wordStartFailed
	}
}

// StartShown is the start problem when the screen shows it: on the starting screen only.
func (s Screen) StartShown() *Start {
	if s.State != Starting {
		return nil
	}
	return s.Start
}

// startBody is the starting screen with a start problem.
func startBody(p *Start) []string {
	return []string{wordStartTitle, "", StartWords(p), "", wordStartRetry}
}
