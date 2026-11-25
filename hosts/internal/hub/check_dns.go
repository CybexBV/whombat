package hub

import (
	"slices"
	"strings"
	"time"

	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

func isAddressLookup(c store.Check) bool {
	return c.Kind == proto.CheckDNS && strings.EqualFold(c.Options.DNSType, "any")
}

// Both the hub and deployed agents already know how to run A and AAAA.
// Ask for both on the selected runner, where the name may be local.
func addressProbeSpecs(c store.Check) [2]proto.CheckSpec {
	a := specOf(c)
	aaaa := a
	a.ID, a.DNSType = a.ID+".a", "A"
	aaaa.ID, aaaa.DNSType = aaaa.ID+".aaaa", "AAAA"
	return [2]proto.CheckSpec{a, aaaa}
}

type addressProbePair struct {
	check   store.Check
	results [2]proto.CheckResult
}

func (p *addressProbePair) observation() (checkObservation, bool) {
	a, aaaa := p.results[0], p.results[1]
	if a.At.IsZero() || aaaa.At.IsZero() {
		return checkObservation{}, false
	}
	result := a
	if aaaa.OK && (!a.OK || aaaa.At.Before(a.At)) {
		result = aaaa
	}
	if a.OK || aaaa.OK {
		result.Answer = slices.Concat(a.Answer, aaaa.Answer)
		result.Answer = result.Answer[:min(len(result.Answer), 8)]
	}
	if aaaa.At.After(a.At) {
		result.At = aaaa.At
	} else {
		result.At = a.At
	}
	return checkObservation{result: result, addressAt: [2]time.Time{a.At, aaaa.At}}, true
}
