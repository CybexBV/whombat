package local

import "strings"

// ConsoleStateValid reports whether a console file is consistent (CC-08), like consoleStateValid in
// @whombat/control-contracts/local: Code exactly in state claimable, RetryAt exactly in state backoff, LettersUntil,
// FallbackURL and PageOpen only in state claimable, NewLetters only in claimable and backoff, Ipv6Only never in claimed, Burrows
// (CT-116) and SignIn (0.106, CT-626) only in state claimed. Validate the JSON with
// ParseConsoleState first. A console that finds a SignIn outside claimed may drop it and keep the rest.
func ConsoleStateValid(s ConsoleState) bool {
	return (s.State == ConsoleClaimStateClaimable) == (s.Code != nil) &&
		(s.State == ConsoleClaimStateBackoff) == (s.RetryAt != nil) &&
		(s.LettersUntil == nil || s.State == ConsoleClaimStateClaimable) &&
		(s.NewLetters == nil || s.State == ConsoleClaimStateClaimable || s.State == ConsoleClaimStateBackoff) &&
		(s.Ipv6Only == nil || s.State != ConsoleClaimStateClaimed) &&
		(s.FallbackURL == nil || s.State == ConsoleClaimStateClaimable) &&
		(s.PageOpen == nil || s.State == ConsoleClaimStateClaimable) &&
		(s.Burrows == nil || s.State == ConsoleClaimStateClaimed) &&
		(s.SignIn == nil || s.State == ConsoleClaimStateClaimed)
}

// ConsoleDisplayURL is the URL as the console shows it: without "https://" or "http://".
func ConsoleDisplayURL(url string) string {
	if u, ok := strings.CutPrefix(url, "https://"); ok {
		return u
	}
	return strings.TrimPrefix(url, "http://")
}

// ClaimLookupLeaseValid reports whether ExpiresAt accompanies a lookup number and nothing else (CC-03).
func ClaimLookupLeaseValid(r ClaimLookupLeaseRequest) bool {
	return (r.Lookup != nil) == (r.ExpiresAt != nil)
}
