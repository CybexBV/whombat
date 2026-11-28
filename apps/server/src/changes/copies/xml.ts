/**
 * A small XML reader for a settings export (OPNsense's `config.xml`): elements with their attributes, children and
 * text; comments, processing instructions, the doctype and CDATA handled; entities decoded. Lenient: a closing tag
 * closes up to its element. Enough to compare two exports, not a general parser.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const NODES_MAX = 400_000;
const DEPTH_MAX = 64;

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** The document as a root node named `#root` whose children are its top elements. */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  let nodes = 0;
  const top = () => stack[stack.length - 1] as XmlNode;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      top().text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      top().text += src.slice(lt + 9, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    const gt = src.indexOf('>', lt + 1);
    if (gt === -1) break;
    const inner = src.slice(lt + 1, gt);
    i = gt + 1;
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      const at = stack.map((n) => n.name).lastIndexOf(name);
      if (at > 0) stack.length = at;
      continue;
    }
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const name = /^[^\s/>]+/.exec(body)?.[0];
    if (!name) continue;
    if (++nodes > NODES_MAX) throw new Error('The export is larger than Whombat compares.');
    const attrs: Record<string, string> = {};
    for (const m of body.slice(name.length).matchAll(ATTR))
      attrs[m[1] as string] = decodeEntities(m[3] ?? m[4] ?? '');
    const node: XmlNode = { name, attrs, children: [], text: '' };
    top().children.push(node);
    if (!selfClosing && stack.length < DEPTH_MAX) stack.push(node);
  }
  return root;
}

/** The children of `node` named `name` (`*`: all). */
export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return name === '*' ? node.children : node.children.filter((c) => c.name === name);
}

/** The elements at `path` below `node`: each step a child name, `*` any. */
export function nodesAt(node: XmlNode, path: readonly string[]): XmlNode[] {
  let at = [node];
  for (const step of path) at = at.flatMap((n) => childrenNamed(n, step));
  return at;
}

/** The text of the first child named `name`, trimmed; null when there is none or it is empty. */
export function childText(node: XmlNode, name: string): string | null {
  const t = node.children.find((c) => c.name === name)?.text.trim();
  return t ? t : null;
}

/**
 * An element as a plain value for hashing: its text when it has no children, else its attributes and children by name
 * (a name seen more than once as a list).
 */
export function xmlValue(node: XmlNode): unknown {
  if (!node.children.length && !Object.keys(node.attrs).length) return node.text.trim();
  const byName = new Map<string, unknown[]>();
  for (const c of node.children) {
    const list = byName.get(c.name) ?? [];
    list.push(xmlValue(c));
    byName.set(c.name, list);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.attrs)) out[`@${k}`] = v;
  for (const [name, list] of byName) out[name] = list.length === 1 ? list[0] : list;
  const text = node.text.trim();
  if (text) out['#text'] = text;
  return out;
}
