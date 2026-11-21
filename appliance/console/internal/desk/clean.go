package desk

import (
	"strings"

	"github.com/CybexBV/whombat/appliance/console/internal/screen"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// line is s as the page may draw it: one line of plain text (screen.CleanName: no C0, DEL, C1, format characters
// such as bidi overrides and zero-width joiners, line or paragraph separators), trimmed, at most max code points. The
// runtime already sends display texts (the contract's ConsoleDisplayText rules); this is the console's own check, as
// for the burrow's name (NX-78): whatever a runtime sends, the page gets nothing that isn't plain text.
func line(s string, max int) string {
	s = strings.TrimSpace(screen.CleanName(s))
	if r := []rune(s); len(r) > max {
		s = strings.TrimSpace(string(r[:max]))
	}
	return s
}

func optLine(s *string, max int) *string {
	if s == nil {
		return nil
	}
	v := line(*s, max)
	if v == "" {
		return nil
	}
	return &v
}

// cleanState cleans every display string of the state in place.
func cleanState(st *State) {
	if p := st.Paired; p != nil {
		p.Person.Name = line(p.Person.Name, maxName)
		p.Person.Initial = line(p.Person.Initial, 2)
		p.Assistant.Name = line(p.Assistant.Name, maxName)
	}
	if g := st.Glance; g != nil {
		g.Status.Text = line(g.Status.Text, maxStatus)
		g.Status.More = optLine(g.Status.More, maxStatus)
		for i := range g.NeedsYou.Items {
			cleanAsk(&g.NeedsYou.Items[i])
		}
		g.NeedsYou.Looks = cleanLooks(g.NeedsYou.Looks)
		if w := g.Working; w != nil {
			w.Title = line(w.Title, maxTitle)
			for i := range w.Steps {
				w.Steps[i].Label = line(w.Steps[i].Label, maxLabel)
			}
		}
		for i := range g.Done {
			g.Done[i].Text = line(g.Done[i].Text, maxDoneText)
		}
		// Servers and tiles five to eight and This Whombat beside them (0.104, DK-39, DK-41) as the first ones.
		for _, servers := range [][]Server{g.Servers, g.ExtraServers} {
			for i := range servers {
				cleanServer(&servers[i])
			}
		}
		for _, tiles := range [][]local.DeskTile{g.Tiles, g.ExtraTiles} {
			for i := range tiles {
				t := &tiles[i]
				t.Value, t.Label = line(t.Value, maxValue), line(t.Label, maxTileText)
			}
		}
		for _, b := range []*Box{g.Box, g.Self} {
			if b != nil {
				cleanBox(b)
			}
		}
		if f := g.Found; f != nil {
			cleanFound(f)
		}
		if c := g.Calm; c != nil {
			cleanCalm(c)
		}
		cleanScreens(g) // the screen of widgets (3.6), screens.go
	}
	st.Name = optLine(st.Name, maxName)
	if t := st.Talk; t != nil {
		cleanTalk(t)
	}
}

// cleanBox cleans This Whombat's words (DK-22, DK-39: the panel or, beside servers, `self`): the uptime, the figures and their units, the totals, the parts and the
// rates. Its numbers are the schema's (whole percentages, the cores, the step) and pass as they are.
func cleanBox(b *Box) {
	b.Up = line(b.Up, maxUp)
	fig := func(f *local.DeskFigure) { f.Value, f.Unit = line(f.Value, maxFigure), line(f.Unit, maxFigure) }
	fig(&b.Memory.Used)
	fig(&b.Storage.Free)
	b.Memory.Total, b.Storage.Total = line(b.Memory.Total, maxBoxText), line(b.Storage.Total, maxBoxText)
	for i := range b.Storage.Parts {
		b.Storage.Parts[i].Value = line(b.Storage.Parts[i].Value, maxBoxText)
	}
	if n := b.Network; n != nil {
		n.Down, n.Up = line(n.Down, maxBoxText), line(n.Up, maxBoxText)
	}
}

// cleanFound cleans found on your network's words (0.110, DF-01, DF-08): each service's name, short line and address.
// One left without a name or an address goes (the count still counts it); the numbers and times are the schema's.
func cleanFound(f *Found) {
	items := f.Items[:0]
	for _, it := range f.Items {
		it.Name = line(it.Name, maxFoundName)
		it.Tagline = line(it.Tagline, maxFoundTagline)
		it.Address = line(it.Address, maxFoundAddress)
		if it.Name != "" && it.Address != "" {
			items = append(items, it)
		}
	}
	f.Items = items
}

// cleanLooks cleans what needs a look (0.118, DK-93): a look left without its key or name goes; none left is none.
// Since 0.122 (QN-20, CG-331) Ignore's words and the line's question are cleaned as the reason; the line (`notice`) is
// no display text and stays exactly as sent, for `look/quiet` to send back; a heads-up (`fyi`) is never a look (QN-02)
// and goes. Since 3.5 (CG-370) what the assistant found out is cleaned by cleanResearch.
func cleanLooks(looks []Look) []Look {
	kept := looks[:0]
	for _, l := range looks {
		l.Key, l.Name = line(l.Key, maxLookKey), line(l.Name, maxName)
		l.Reason = optLine(l.Reason, maxLookReason)
		l.IgnoreWords = optLine(l.IgnoreWords, maxLookWords)
		l.Question = optLine(l.Question, maxLookQuestion)
		l.Research = cleanResearch(l.Research, l.Key)
		fyi := l.Nature != nil && *l.Nature == local.NoticeNatureFyi
		if l.Key != "" && l.Name != "" && !fyi {
			kept = append(kept, l)
		}
	}
	if len(kept) == 0 {
		return nil
	}
	return kept
}

// cleanResearch cleans what the assistant found out about a look (3.5, CG-370): its title and summary as display text,
// the step's label only while it is offered (`found`: a step the screen shows is one the runtime takes). Research about
// another look than the one it sits on goes, and the look shows as it did before. The thread's ids and the time are
// the schema's and pass as they are.
func cleanResearch(r *LookResearch, key string) *LookResearch {
	if r == nil {
		return nil
	}
	if r.Key = line(r.Key, maxLookKey); r.Key != key {
		return nil
	}
	r.Title = optLine(r.Title, maxResearchTitle)
	r.Summary = optLine(r.Summary, maxResearchSummary)
	r.Fix = optLine(r.Fix, maxFixLabel)
	if r.State != "found" {
		r.Fix = nil
	}
	return r
}

func cleanAsk(a *Ask) {
	a.Title = line(a.Title, maxTitle)
	a.Where = optLine(a.Where, maxWhere)
	a.Detail = optLine(a.Detail, maxDetail)
	a.ApproveLabel = optLine(a.ApproveLabel, maxLabel)
	// Who asks (0.116, TF-15): none left is the agent.
	a.From = optLine(a.From, maxFrom)
	// The wider choices (0.116, TF-14): one left without its label goes; none left is none.
	choices := a.Choices[:0]
	for _, ch := range a.Choices {
		if ch.Label = line(ch.Label, maxChoice); ch.Label != "" {
			choices = append(choices, ch)
		}
	}
	a.Choices = choices
	if len(a.Choices) == 0 {
		a.Choices = nil
	}
	facts := a.Facts[:0]
	for _, f := range a.Facts {
		if f = line(f, maxFact); f != "" {
			facts = append(facts, f)
		}
	}
	a.Facts = facts
	if len(a.Facts) == 0 {
		a.Facts = nil
	}
}

func cleanServer(s *Server) {
	s.Name, s.Note = line(s.Name, maxName), line(s.Note, maxNote)
}

// cleanServerPage cleans a server's own screen's words (0.115, DK-83): the card as the glance's, the OS and uptime, the
// figures' words and units, the volumes', guests' and alerts' names, the rates. A volume, guest or alert left without
// its name goes (the counts still count it); the numbers are the schema's.
func cleanServerPage(p *ServerPage) {
	cleanServer(&p.Server)
	p.Os, p.Up = line(p.Os, maxOS), line(p.Up, maxUp)
	if c := p.Cpu; c != nil {
		c.Load = line(c.Load, maxFigure)
	}
	if m := p.Memory; m != nil {
		m.Used.Value, m.Used.Unit = line(m.Used.Value, maxFigure), line(m.Used.Unit, maxFigure)
		m.Total = line(m.Total, maxBoxText)
	}
	if d := p.Disk; d != nil {
		d.Used, d.Total = line(d.Used, maxBoxText), line(d.Total, maxBoxText)
	}
	vols := p.Volumes[:0]
	for _, v := range p.Volumes {
		v.Name, v.Note = line(v.Name, maxName), line(v.Note, maxNote)
		v.Used, v.Total = line(v.Used, maxBoxText), line(v.Total, maxBoxText)
		if v.Name != "" {
			vols = append(vols, v)
		}
	}
	p.Volumes = vols
	if g := p.Guests; g != nil {
		items := g.Items[:0]
		for _, it := range g.Items {
			it.Name, it.Memory = line(it.Name, maxGuestName), line(it.Memory, maxBoxText)
			if it.Name != "" {
				items = append(items, it)
			}
		}
		g.Items = items
	}
	if n := p.Network; n != nil {
		n.Down, n.Up = line(n.Down, maxBoxText), line(n.Up, maxBoxText)
	}
	alerts := p.Alerts.Items[:0]
	for _, a := range p.Alerts.Items {
		if a.Title = line(a.Title, maxAlertTitle); a.Title != "" {
			alerts = append(alerts, a)
		}
	}
	p.Alerts.Items = alerts
}

// cleanSession cleans the conversation's words (0.108, DK-63): each paragraph as an answer's, a paragraph left empty
// goes, and a message left without one goes; the server an answer names as the glance's. 0.116 (TF-17): what the
// assistant is doing (none left: none), a task's title and result (a task left without its title goes, and the message
// shows as its paragraphs, the card's line).
func cleanSession(s *Session) {
	msgs := s.Messages[:0]
	for _, m := range s.Messages {
		paras := m.Paragraphs[:0]
		for _, p := range m.Paragraphs {
			if p = line(p, maxAnswer); p != "" {
				paras = append(paras, p)
			}
		}
		if len(paras) == 0 {
			continue
		}
		m.Paragraphs = paras
		if m.Thing != nil {
			cleanServer(m.Thing)
		}
		if t := m.Task; t != nil {
			t.Title = line(t.Title, maxTaskTitle)
			t.Result = optLine(t.Result, maxAnswer)
			if t.Title == "" {
				m.Task = nil
			}
		}
		msgs = append(msgs, m)
	}
	s.Messages = msgs
	if w := s.Working; w != nil {
		w.Doing = optLine(w.Doing, maxDoing)
	}
}

func cleanTalk(t *Talk) {
	t.Question = optLine(t.Question, maxQuestion)
	t.Answer = optLine(t.Answer, maxAnswer)
	if t.Thing != nil {
		cleanServer(t.Thing)
	}
}

// cleanCalm cleans the calm glance's words (3.2, CG-350; Whombat DK-101…DK-124): the sentence, the hero, the lines
// under it, the moments, the strip and Welcome back. Something left without the words it can't do without goes (a
// moment without a name or value, a strip server without a name, a line without text); a hero without a title goes
// too, and the screen then draws the moments. Numbers, keys and times are the schema's and pass as they are. A look's
// hero carries where its research is and the step it offers (3.5, CG-370).
func cleanCalm(c *local.DeskGlanceCalm) {
	c.Headline.Text = line(c.Headline.Text, maxCalmHeadline)
	c.Headline.More = optLine(c.Headline.More, maxStatus)
	if h := c.Hero; h != nil {
		h.Title = line(h.Title, maxTitle)
		h.Detail = optLine(h.Detail, maxStatus)
		h.Look = optLine(h.Look, maxLookKey)
		// A look's research and its step (3.5, CG-370): only on a look's hero, the step only once it was found.
		h.Fix = optLine(h.Fix, maxFixLabel)
		if h.Kind != "look" {
			h.Research = nil
		}
		if h.Research == nil || *h.Research != "found" {
			h.Fix = nil
		}
		if h.Title == "" {
			c.Hero = nil
		}
	}
	also := c.Also[:0]
	for _, a := range c.Also {
		a.Name, a.Text = line(a.Name, maxName), line(a.Text, maxTitle)
		a.Look = optLine(a.Look, maxLookKey)
		if a.Name != "" && a.Text != "" {
			also = append(also, a)
		}
	}
	c.Also = also
	moments := c.Moments[:0]
	for _, m := range c.Moments {
		m.Name, m.Value = line(m.Name, maxName), line(m.Value, maxName)
		m.Detail = optLine(m.Detail, maxCalmDetail)
		if m.Name != "" && m.Value != "" {
			moments = append(moments, m)
		}
	}
	c.Moments = moments
	strip := c.Strip[:0]
	for _, s := range c.Strip {
		s.Name = line(s.Name, maxName)
		s.Say = optLine(s.Say, maxName)
		if s.Name != "" {
			strip = append(strip, s)
		}
	}
	c.Strip = strip
	if d := c.Digest; d != nil {
		items := d.Items[:0]
		for _, it := range d.Items {
			it.Text = line(it.Text, maxTitle)
			it.Look = optLine(it.Look, maxLookKey)
			if it.Text != "" {
				items = append(items, it)
			}
		}
		d.Items = items
		if len(items) == 0 {
			c.Digest = nil
		}
	}
}
