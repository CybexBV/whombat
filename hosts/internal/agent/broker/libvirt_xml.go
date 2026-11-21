package broker

import (
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"strings"
)

// A small XML tree for libvirt's documents (domain, pool, volume, network
// XML). Edits change single nodes; everything else — unknown elements,
// attributes and their order, namespaces with their prefixes, comments —
// is written back as it was read, so Whombat never regenerates a domain
// from its own idea of it (docs/MANAGE.md 2.7).

type xnodeKind uint8

const (
	xElem xnodeKind = iota
	xText
	xComment
	xProcInst
	xDirective
)

// xnode is an element, or a text, comment, processing instruction or
// directive inside one. Names keep their prefix ("libosinfo:os").
type xnode struct {
	kind  xnodeKind
	name  string
	attrs []xml.Attr // Name.Space is the prefix ("xmlns" for declarations)
	kids  []*xnode
	text  string // text, comment, directive; procinst: target + " " + data
}

// parseXMLTree reads a document and returns its root element. Content
// before and after the root (a declaration, comments) is dropped: libvirt
// documents have none worth keeping.
func parseXMLTree(s string) (*xnode, error) {
	d := xml.NewDecoder(strings.NewReader(s))
	d.Strict = true
	var stack []*xnode
	var root *xnode
	for {
		tok, err := d.RawToken()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		var n *xnode
		switch t := tok.(type) {
		case xml.StartElement:
			n = &xnode{kind: xElem, name: rawName(t.Name), attrs: append([]xml.Attr(nil), t.Attr...)}
			if len(stack) > 0 {
				p := stack[len(stack)-1]
				p.kids = append(p.kids, n)
			} else if root == nil {
				root = n
			} else {
				return nil, errors.New("more than one root element")
			}
			stack = append(stack, n)
			continue
		case xml.EndElement:
			if len(stack) == 0 || stack[len(stack)-1].name != rawName(t.Name) {
				return nil, errors.New("mismatched end element " + rawName(t.Name))
			}
			stack = stack[:len(stack)-1]
			continue
		case xml.CharData:
			n = &xnode{kind: xText, text: string(t)}
		case xml.Comment:
			n = &xnode{kind: xComment, text: string(t)}
		case xml.ProcInst:
			n = &xnode{kind: xProcInst, text: t.Target + " " + string(t.Inst)}
		case xml.Directive:
			n = &xnode{kind: xDirective, text: string(t)}
		}
		if len(stack) > 0 && n != nil {
			p := stack[len(stack)-1]
			p.kids = append(p.kids, n)
		}
	}
	if root == nil {
		return nil, errors.New("no root element")
	}
	if len(stack) > 0 {
		return nil, errors.New("unexpected end of the document")
	}
	return root, nil
}

func rawName(n xml.Name) string {
	if n.Space != "" {
		return n.Space + ":" + n.Local
	}
	return n.Local
}

// String serializes the tree.
func (n *xnode) String() string {
	if n == nil {
		return ""
	}
	var b bytes.Buffer
	n.write(&b)
	return b.String()
}

func (n *xnode) write(b *bytes.Buffer) {
	switch n.kind {
	case xText:
		b.WriteString(textEscaper.Replace(n.text))
		return
	case xComment:
		b.WriteString("<!--" + n.text + "-->")
		return
	case xProcInst:
		b.WriteString("<?" + n.text + "?>")
		return
	case xDirective:
		b.WriteString("<!" + n.text + ">")
		return
	}
	b.WriteString("<" + n.name)
	for _, a := range n.attrs {
		b.WriteString(" " + rawName(a.Name) + "='")
		b.WriteString(escapeAttr(a.Value))
		b.WriteString("'")
	}
	if len(n.kids) == 0 {
		b.WriteString("/>")
		return
	}
	b.WriteString(">")
	for _, k := range n.kids {
		k.write(b)
	}
	b.WriteString("</" + n.name + ">")
}

var textEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

func escapeAttr(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "'", "&apos;", "\"", "&quot;", "\n", "&#10;",
		"\r", "&#13;", "\t", "&#9;").Replace(s)
}

// newElem returns an element with attributes given as name, value pairs.
func newElem(name string, attrs ...string) *xnode {
	n := &xnode{kind: xElem, name: name}
	for i := 0; i+1 < len(attrs); i += 2 {
		n.setAttr(attrs[i], attrs[i+1])
	}
	return n
}

// child returns the first child element with the name, or nil.
func (n *xnode) child(name string) *xnode {
	if n == nil {
		return nil
	}
	for _, k := range n.kids {
		if k.kind == xElem && k.name == name {
			return k
		}
	}
	return nil
}

// children returns the child elements with the name ("" = every element).
func (n *xnode) children(name string) []*xnode {
	if n == nil {
		return nil
	}
	var out []*xnode
	for _, k := range n.kids {
		if k.kind == xElem && (name == "" || k.name == name) {
			out = append(out, k)
		}
	}
	return out
}

// path follows child elements ("devices/disk" = the first disk).
func (n *xnode) path(p string) *xnode {
	for _, part := range strings.Split(p, "/") {
		n = n.child(part)
		if n == nil {
			return nil
		}
	}
	return n
}

// ensure returns the child element with the name, appending it when
// missing.
func (n *xnode) ensure(name string) *xnode {
	if c := n.child(name); c != nil {
		return c
	}
	c := &xnode{kind: xElem, name: name}
	n.kids = append(n.kids, c)
	return c
}

func (n *xnode) attr(name string) string {
	if n == nil {
		return ""
	}
	for _, a := range n.attrs {
		if rawName(a.Name) == name {
			return a.Value
		}
	}
	return ""
}

func (n *xnode) hasAttr(name string) bool {
	for _, a := range n.attrs {
		if rawName(a.Name) == name {
			return true
		}
	}
	return false
}

func (n *xnode) setAttr(name, value string) {
	for i, a := range n.attrs {
		if rawName(a.Name) == name {
			n.attrs[i].Value = value
			return
		}
	}
	var xn xml.Name
	if p, l, ok := strings.Cut(name, ":"); ok {
		xn = xml.Name{Space: p, Local: l}
	} else {
		xn = xml.Name{Local: name}
	}
	n.attrs = append(n.attrs, xml.Attr{Name: xn, Value: value})
}

func (n *xnode) delAttr(name string) {
	out := n.attrs[:0]
	for _, a := range n.attrs {
		if rawName(a.Name) != name {
			out = append(out, a)
		}
	}
	n.attrs = out
}

// textContent is the element's text (its text children joined), trimmed.
func (n *xnode) textContent() string {
	if n == nil {
		return ""
	}
	var b strings.Builder
	for _, k := range n.kids {
		if k.kind == xText {
			b.WriteString(k.text)
		}
	}
	return strings.TrimSpace(b.String())
}

// setText replaces the element's children with one text.
func (n *xnode) setText(s string) {
	n.kids = []*xnode{{kind: xText, text: s}}
}

// add appends a child element and returns it.
func (n *xnode) add(c *xnode) *xnode {
	n.kids = append(n.kids, c)
	return c
}

// insertAfter puts c after the last child element named one of names
// (keeping libvirt's element order readable), else at the end.
func (n *xnode) insertAfter(c *xnode, names ...string) {
	at := -1
	for i, k := range n.kids {
		if k.kind != xElem {
			continue
		}
		for _, nm := range names {
			if k.name == nm {
				at = i
			}
		}
	}
	if at < 0 {
		n.kids = append(n.kids, c)
		return
	}
	n.kids = append(n.kids[:at+1], append([]*xnode{c}, n.kids[at+1:]...)...)
}

// remove drops the child c (and the whitespace text right before it).
func (n *xnode) remove(c *xnode) {
	for i, k := range n.kids {
		if k != c {
			continue
		}
		start := i
		if i > 0 && n.kids[i-1].kind == xText && strings.TrimSpace(n.kids[i-1].text) == "" {
			start = i - 1
		}
		n.kids = append(n.kids[:start], n.kids[i+1:]...)
		return
	}
}

// removeAll drops every child element with the name.
func (n *xnode) removeAll(name string) {
	for _, c := range n.children(name) {
		n.remove(c)
	}
}

// replace puts nw where old was.
func (n *xnode) replace(old, nw *xnode) bool {
	for i, k := range n.kids {
		if k == old {
			n.kids[i] = nw
			return true
		}
	}
	return false
}

// clone is a deep copy.
func (n *xnode) clone() *xnode {
	c := &xnode{kind: n.kind, name: n.name, text: n.text, attrs: append([]xml.Attr(nil), n.attrs...)}
	for _, k := range n.kids {
		c.kids = append(c.kids, k.clone())
	}
	return c
}
