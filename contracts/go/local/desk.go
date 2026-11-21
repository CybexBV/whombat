package local

import "regexp"

// DeskTalkValid reports whether a talk is consistent (CT-530), like deskTalkValid in
// @whombat/control-contracts/local: Answer exactly in state answered, Reason exactly in state failed.
func DeskTalkValid(t DeskTalk) bool {
	return (t.State == DeskTalkStateAnswered) == (t.Answer != nil) &&
		(t.State == DeskTalkStateFailed) == (t.Reason != nil)
}

// DeskStateValid reports whether a desk state is consistent (CT-530), like deskStateValid in
// @whombat/control-contracts/local: the lock's time exactly in its state (Until in unlocked, ExpiresAt in phone,
// RetryAt in backoff); nobody paired means locked, no glance and no talk; an ask's words (Detail, Facts,
// ApproveLabel) only while unlocked; PhoneReason exactly when not OnDesk; no more items than Count; a valid talk.
// Since 0.101 (CT-545): a Box only on a glance without servers and tiles, and not while locked in DeskLockedViewTime;
// its history's two series the same length. Since 0.103 (CT-596): Camera or Present true only while unlocked, and
// Present true only with Camera true (false says nothing, wherever it is). Since 0.104 (CT-601, CT-602): a Self never
// with Box, only on a glance with a server or a tile, not while locked in DeskLockedViewTime, its history's two series
// the same length; ExtraServers only beside four Servers and no more of them than MoreServers; ExtraTiles only beside
// four Tiles (an empty list says nothing, wherever it is). Since 0.107 (CT-648): Stays true only while unlocked; a
// Presence only while paired. Since 0.108 (CT-660): ApproveWithPin true only with OnDesk false. Since 0.110 (CT-700):
// Found not while locked in DeskLockedViewTime, and DeskFoundValid. Since 0.116 (CT-890): an ask's Choices only while
// unlocked, only on an ask the screen may approve (OnDesk, or ApproveWithPin), not on a screen without a PIN (HasPin
// false), each scope once.
// Validate the JSON with ParseDeskState first; show no desk for a state that fails this.
func DeskStateValid(s DeskState) bool {
	l := s.Lock
	if (l.State == DeskLockStateUnlocked) != (l.Until != nil) ||
		(l.State == DeskLockStatePhone) != (l.ExpiresAt != nil) ||
		(l.State == DeskLockStateBackoff) != (l.RetryAt != nil) {
		return false
	}
	camera, present := isTrue(l.Camera), isTrue(l.Present)
	if (l.State != DeskLockStateUnlocked && (camera || present)) || (present && !camera) {
		return false
	}
	if isTrue(l.Stays) && l.State != DeskLockStateUnlocked {
		return false
	}
	if s.Paired == nil && (s.Glance != nil || s.Talk != nil || s.Presence != nil || l.State != DeskLockStateLocked) {
		return false
	}
	if s.Talk != nil && !DeskTalkValid(*s.Talk) {
		return false
	}
	g := s.Glance
	if g == nil {
		return true
	}
	timeOnly := l.State != DeskLockStateUnlocked && s.Paired != nil && s.Paired.LockedView == DeskLockedViewTime
	serversOrTiles := len(g.Servers) > 0 || len(g.Tiles) > 0
	if b := g.Box; b != nil && (serversOrTiles || timeOnly || len(b.History.Cpu) != len(b.History.Memory)) {
		return false
	}
	if b := g.Self; b != nil &&
		(g.Box != nil || !serversOrTiles || timeOnly || len(b.History.Cpu) != len(b.History.Memory)) {
		return false
	}
	if n := len(g.ExtraServers); n > 0 && (len(g.Servers) != 4 || g.MoreServers < int64(n)) {
		return false
	}
	if len(g.ExtraTiles) > 0 && len(g.Tiles) != 4 {
		return false
	}
	if f := g.Found; f != nil && (timeOnly || !DeskFoundValid(*f)) {
		return false
	}
	if len(g.NeedsYou.Looks) > 0 && timeOnly {
		return false
	}
	items := g.NeedsYou.Items
	if int64(len(items)) > g.NeedsYou.Count {
		return false
	}
	noPin := s.Paired != nil && !s.Paired.HasPin
	for _, a := range items {
		if a.OnDesk != (a.PhoneReason == nil) || (isTrue(a.ApproveWithPin) && a.OnDesk) {
			return false
		}
		if l.State != DeskLockStateUnlocked && (a.Detail != nil || a.Facts != nil || a.ApproveLabel != nil) {
			return false
		}
		if len(a.Choices) > 0 && !deskChoicesValid(a, l.State == DeskLockStateUnlocked && !noPin) {
			return false
		}
	}
	return true
}

// deskChoicesValid: an ask's wider choices (0.116, CT-890) only where they may show (unlocked, with a PIN), on an ask
// the screen may approve, each scope once.
func deskChoicesValid(a DeskAsk, mayShow bool) bool {
	if !mayShow || !(a.OnDesk || isTrue(a.ApproveWithPin)) {
		return false
	}
	seen := make(map[DeskChoiceScope]bool, len(a.Choices))
	for _, c := range a.Choices {
		if seen[c.Scope] {
			return false
		}
		seen[c.Scope] = true
	}
	return true
}

// DeskFoundValid reports whether found on your network is consistent (0.110, CT-700), like deskFoundValid in
// @whombat/control-contracts/local: no more Items than Count; FinishedAt nil only while Scanning; Progress only then,
// Done at most Total; Count 0 only while the first scan looks (FinishedAt nil).
func DeskFoundValid(f DeskFound) bool {
	if int64(len(f.Items)) > f.Count {
		return false
	}
	if f.FinishedAt == nil && !f.Scanning {
		return false
	}
	if p := f.Progress; p != nil && (f.FinishedAt != nil || p.Done > p.Total) {
		return false
	}
	return f.Count > 0 || f.FinishedAt == nil
}

// DeskServerPageValid reports whether a server's own screen is consistent (0.115, CT-866), like deskServerPageValid in
// @whombat/control-contracts/local: the card has its ID; the chart's two series the same length; no more alert Items
// than Count; no more guest Items than Running and Off together. The console server also checks that Server.ID is the
// id it asked for. Validate the JSON with ParseDeskServerPage first; show no page for one that fails either.
func DeskServerPageValid(p DeskServerPage) bool {
	if p.Server.ID == nil {
		return false
	}
	if len(p.History.Cpu) != len(p.History.Memory) {
		return false
	}
	if int64(len(p.Alerts.Items)) > p.Alerts.Count {
		return false
	}
	g := p.Guests
	return g == nil || int64(len(g.Items)) <= g.Running+g.Off
}

var deskServerIDRe = regexp.MustCompile(DeskServerIDPattern)

// ValidDeskServerID reports whether s is a server id the desk socket accepts (0.115, CT-862; DeskServerIDPattern, like
// DESK_SERVER_ID_RE in @whombat/core/domain): the hosts service's id, a slug of the host name (older hubs: with dots),
// starting with a letter or a digit, no slash, at most 128 characters.
func ValidDeskServerID(s string) bool { return deskServerIDRe.MatchString(s) }

// DeskTalkRequestValid reports whether a talk request carries exactly one of Text and AudioWav (CT-531), like
// deskTalkRequestValid in @whombat/control-contracts/local.
func DeskTalkRequestValid(r DeskTalkRequest) bool {
	return (r.Text != nil) != (r.AudioWav != nil)
}

// DeskTalkSessionValid reports whether a conversation is consistent (0.108, CT-664), like deskTalkSessionValid in
// @whombat/control-contracts/local: Until exactly while open; a closed one shows no messages and counts none earlier.
// Since 0.116 (CT-894, CT-895): Working only while open; a message's Task has EndedAt exactly when not running and a
// Result only then, and no message has both Ask and Task.
func DeskTalkSessionValid(s DeskTalkSession) bool {
	for _, m := range s.Messages {
		if t := m.Task; t != nil {
			running := t.State == DeskTaskStateRunning
			if m.Ask != nil || running != (t.EndedAt == nil) || (running && t.Result != nil) {
				return false
			}
		}
	}
	if s.Open {
		return s.Until != nil
	}
	return len(s.Messages) == 0 && s.Earlier == 0 && s.Until == nil && s.Working == nil
}

// DeskDecideRequestValid reports whether a decision is consistent (0.116, CT-891), like deskDecideRequestValid in
// @whombat/control-contracts/local: a Scope only with DeskDecisionApprove.
func DeskDecideRequestValid(r DeskDecideRequest) bool {
	return r.Scope == nil || r.Decision == DeskDecisionApprove
}

// DeskDecideNeedsPin reports whether a decision needs the PIN typed again (0.108, DK-62; 0.116, CT-891), like
// deskDecideNeedsPin in @whombat/control-contracts/local: an approve of an ask with ApproveWithPin, or an approve with
// any scope wider than once. Deny and Not now never do.
func DeskDecideNeedsPin(approveWithPin bool, r DeskDecideRequest) bool {
	if r.Decision != DeskDecisionApprove {
		return false
	}
	return approveWithPin || (r.Scope != nil && *r.Scope != DeskDecideScopeOnce)
}

func isTrue(b *bool) bool { return b != nil && *b }
