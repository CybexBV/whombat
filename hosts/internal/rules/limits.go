package rules

import (
	"strconv"
	"strings"
)

// LimitLookup returns the limit set for the entity or its server.
type LimitLookup func(rule, entity string) (float64, bool)

func ValidLimitRule(rule string) bool {
	switch rule {
	case RuleTempHigh, RuleTempCritical, RuleWearHigh, RuleWearCritical, RuleSpaceHigh, RuleInodesHigh:
		return true
	}
	return false
}

func ValidLimit(rule string, value float64) bool {
	maximum := 100.0
	if rule == RuleTempHigh || rule == RuleTempCritical {
		maximum = 150
	}
	return ValidLimitRule(rule) && value >= 1 && value <= maximum
}

// LimitPair gives the warning and critical rules that share a reading.
func LimitPair(rule string) (warning, critical string) {
	switch rule {
	case RuleTempHigh, RuleTempCritical:
		return RuleTempHigh, RuleTempCritical
	case RuleWearHigh, RuleWearCritical:
		return RuleWearHigh, RuleWearCritical
	}
	return "", ""
}

func warningThreshold(find LimitLookup, rule, entity string, fallback, critical float64) (float64, bool) {
	if value, ok := find.threshold(rule, entity, fallback); value < critical {
		return value, ok
	}
	// Temperature warnings follow their sensor. Wear keeps its fixed default.
	if rule == RuleTempHigh && fallback >= critical {
		fallback = TempWarnThreshold(critical)
	}
	return fallback, false
}

func (find LimitLookup) threshold(rule, entity string, fallback float64) (float64, bool) {
	if find != nil {
		if value, ok := find(rule, entity); ok {
			return value, true
		}
	}
	return fallback, false
}

func limitWords(reading, threshold float64, unit string) string {
	relation := "Above"
	if reading <= threshold+eps {
		relation = "At"
	}
	return relation + " your limit of " + strconv.FormatFloat(threshold, 'f', -1, 64) + " " + unit
}

func withLimitWords(detail string, reading, threshold float64, unit string, custom bool) string {
	if !custom {
		return detail
	}
	words := limitWords(reading, threshold, unit)
	if detail == "" {
		return words
	}
	return detail + " · " + strings.ToLower(words[:1]) + words[1:]
}
