package screen

import (
	"slices"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// Alert is a warning shown over every screen of the console, whatever the claim's state (ConsoleState.alert, contracts
// 4.3; Whombat own-address.md): today only a certificate for the box's own address that the box didn't ask for.
type Alert struct {
	Kind  string
	Since time.Time
}

// WordAlertForeign is the foreign-certificate warning, in the words of the runtime's notice (Whombat OWA-10); the
// console names no address, as the file carries none.
const WordAlertForeign = "Someone got a security certificate for your Whombat’s address that your Whombat didn’t ask for. " +
	"Until you know why, don’t use that address. Use the app on your phone or your home network."

// AlertWords is what the console says for an alert kind ("" for one it doesn't know).
func AlertWords(kind string) string {
	if kind == string(local.ConsoleAlertKindOwnAddressForeign) {
		return WordAlertForeign
	}
	return ""
}

// displayAlert is the contract's alert as the console shows it: a known kind and a readable time, else nothing.
func displayAlert(a *local.ConsoleAlert) *Alert {
	if a == nil || !slices.Contains(local.ConsoleAlertKindValues, a.Kind) || AlertWords(string(a.Kind)) == "" {
		return nil
	}
	since, err := time.Parse(time.RFC3339Nano, a.Since)
	if err != nil {
		return nil
	}
	return &Alert{Kind: string(a.Kind), Since: since}
}
