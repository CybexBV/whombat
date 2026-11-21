/**
 * The condition language of automation `condition` steps: a small, safe expression evaluator over the run's
 * scope (`trigger.*`, `steps.<id>.*`). A hand-written tokenizer and recursive-descent parser — never `eval`
 * or `Function` — with hard limits on length, tokens and nesting, and no regular expressions from input.
 *
 *   expr    := or
 *   or      := and ( '||' and )*
 *   and     := not ( '&&' not )*
 *   not     := '!' not | compare
 *   compare := primary ( ( '==' | '!=' | '<' | '<=' | '>' | '>=' ) primary )?
 *   primary := string | number | true | false | null | path | call | '(' expr ')'
 *   path    := ident ( '.' ident )*          (trigger.text, steps.check.text, steps.check.state, run.test)
 *   call    := ident '(' ( expr ( ',' expr )* )? ')'
 *
 * Functions: contains(a, b), startsWith(a, b), endsWith(a, b), lower(a), length(a), isEmpty(a).
 * Strings compare case-sensitively; `contains` on a list checks membership.
 */

export class ExprError extends Error {}

export const EXPR_MAX_LENGTH = 500;
const MAX_TOKENS = 200;
const MAX_DEPTH = 24;

type Token =
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string };

const OPS = ['||', '&&', '==', '!=', '<=', '>=', '<', '>', '!', '(', ')', ',', '.'];

function tokenize(src: string): Token[] {
  if (src.length > EXPR_MAX_LENGTH)
    throw new ExprError(`Keep conditions under ${EXPR_MAX_LENGTH} characters.`);
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let v = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new ExprError('A text in quotes is not closed.');
        const ch = src[i] as string;
        if (ch === '\\') {
          const next = src[i + 1];
          if (next === undefined) throw new ExprError('A text in quotes is not closed.');
          v += next === 'n' ? '\n' : next;
          i += 2;
          continue;
        }
        if (ch === c) {
          i++;
          break;
        }
        v += ch;
        i++;
      }
      out.push({ t: 'str', v });
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
      const raw = m?.[0] ?? c;
      out.push({ t: 'num', v: Number(raw) });
      i += raw.length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      const raw = m?.[0] ?? c;
      out.push({ t: 'id', v: raw });
      i += raw.length;
    } else {
      const op = OPS.find((o) => src.startsWith(o, i));
      if (!op) throw new ExprError(`“${c}” can’t be used in a condition.`);
      out.push({ t: 'op', v: op });
      i += op.length;
    }
    if (out.length > MAX_TOKENS) throw new ExprError('This condition is too long.');
  }
  return out;
}

export type Expr =
  | { k: 'lit'; v: string | number | boolean | null }
  | { k: 'path'; parts: string[] }
  | { k: 'call'; fn: FnName; args: Expr[] }
  | { k: 'not'; e: Expr }
  | { k: 'bin'; op: string; a: Expr; b: Expr };

const FUNCTIONS = {
  contains: 2,
  startsWith: 2,
  endsWith: 2,
  lower: 1,
  length: 1,
  isEmpty: 1,
} as const;
type FnName = keyof typeof FUNCTIONS;

/** Parses a condition; throws `ExprError` with a readable message. */
export function parseExpr(src: string): Expr {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => {
    const t = peek();
    return t?.t === 'op' && t.v === v;
  };
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`Expected “${v}”.`);
    pos++;
  };

  const parseOr = (depth: number): Expr => {
    if (depth > MAX_DEPTH) throw new ExprError('This condition is nested too deeply.');
    let left = parseAnd(depth + 1);
    while (isOp('||')) {
      pos++;
      left = { k: 'bin', op: '||', a: left, b: parseAnd(depth + 1) };
    }
    return left;
  };
  const parseAnd = (depth: number): Expr => {
    let left = parseNot(depth + 1);
    while (isOp('&&')) {
      pos++;
      left = { k: 'bin', op: '&&', a: left, b: parseNot(depth + 1) };
    }
    return left;
  };
  const parseNot = (depth: number): Expr => {
    if (depth > MAX_DEPTH) throw new ExprError('This condition is nested too deeply.');
    if (isOp('!')) {
      pos++;
      return { k: 'not', e: parseNot(depth + 1) };
    }
    return parseCompare(depth + 1);
  };
  const parseCompare = (depth: number): Expr => {
    const left = parsePrimary(depth + 1);
    const t = peek();
    if (t?.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) {
      pos++;
      return { k: 'bin', op: t.v, a: left, b: parsePrimary(depth + 1) };
    }
    return left;
  };
  const parsePrimary = (depth: number): Expr => {
    if (depth > MAX_DEPTH) throw new ExprError('This condition is nested too deeply.');
    const t = peek();
    if (!t) throw new ExprError('The condition ends too early.');
    pos++;
    if (t.t === 'str' || t.t === 'num') return { k: 'lit', v: t.v };
    if (t.t === 'op') {
      if (t.v === '(') {
        const inner = parseOr(depth + 1);
        expect(')');
        return inner;
      }
      throw new ExprError(`Unexpected “${t.v}”.`);
    }
    if (t.v === 'true') return { k: 'lit', v: true };
    if (t.v === 'false') return { k: 'lit', v: false };
    if (t.v === 'null') return { k: 'lit', v: null };
    if (isOp('(')) {
      if (!(t.v in FUNCTIONS)) throw new ExprError(`“${t.v}” is not a function you can use.`);
      pos++;
      const args: Expr[] = [];
      if (!isOp(')')) {
        args.push(parseOr(depth + 1));
        while (isOp(',')) {
          pos++;
          args.push(parseOr(depth + 1));
        }
      }
      expect(')');
      const fn = t.v as FnName;
      if (args.length !== FUNCTIONS[fn])
        throw new ExprError(`${fn} takes ${FUNCTIONS[fn]} ${FUNCTIONS[fn] === 1 ? 'value' : 'values'}.`);
      return { k: 'call', fn, args };
    }
    const parts = [t.v];
    while (isOp('.')) {
      pos++;
      const next = peek();
      if (next?.t !== 'id') throw new ExprError('Expected a name after “.”.');
      parts.push(next.v);
      pos++;
    }
    // `run.*` since 0.67 (CT-323): `run.number`, `run.test`, `run.today.<step>`.
    if (parts[0] !== 'trigger' && parts[0] !== 'steps' && parts[0] !== 'run')
      throw new ExprError(
        `“${parts.join('.')}” is not something a condition can read (use trigger.…, steps.… or run.…).`,
      );
    return { k: 'path', parts };
  };

  const expr = parseOr(0);
  if (pos !== tokens.length) throw new ExprError(`Unexpected “${String(peek()?.v)}”.`);
  return expr;
}

type Value = string | number | boolean | null | Value[] | { [k: string]: Value };

function lookup(scope: Record<string, unknown>, parts: string[]): Value {
  let cur: unknown = scope;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return null;
    if (!Object.hasOwn(cur, p)) return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return (cur ?? null) as Value;
}

function truthy(v: Value): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return !!v;
}

const asText = (v: Value): string =>
  v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);

function evalNode(e: Expr, scope: Record<string, unknown>): Value {
  switch (e.k) {
    case 'lit':
      return e.v;
    case 'path':
      return lookup(scope, e.parts);
    case 'not':
      return !truthy(evalNode(e.e, scope));
    case 'call': {
      const args = e.args.map((a) => evalNode(a, scope));
      const [a, b] = args as [Value, Value];
      switch (e.fn) {
        case 'contains':
          return Array.isArray(a) ? a.some((x) => asText(x) === asText(b)) : asText(a).includes(asText(b));
        case 'startsWith':
          return asText(a).startsWith(asText(b));
        case 'endsWith':
          return asText(a).endsWith(asText(b));
        case 'lower':
          return asText(a).toLowerCase();
        case 'length':
          return Array.isArray(a) ? a.length : asText(a).length;
        case 'isEmpty':
          return !truthy(a) || (typeof a === 'string' && a.trim() === '');
      }
      return null;
    }
    case 'bin': {
      if (e.op === '&&') return truthy(evalNode(e.a, scope)) && truthy(evalNode(e.b, scope));
      if (e.op === '||') return truthy(evalNode(e.a, scope)) || truthy(evalNode(e.b, scope));
      const a = evalNode(e.a, scope);
      const b = evalNode(e.b, scope);
      if (e.op === '==') return asText(a) === asText(b) && typeof a === typeof b;
      if (e.op === '!=') return !(asText(a) === asText(b) && typeof a === typeof b);
      const na = typeof a === 'number' ? a : Number(a);
      const nb = typeof b === 'number' ? b : Number(b);
      if (Number.isNaN(na) || Number.isNaN(nb)) return false;
      if (e.op === '<') return na < nb;
      if (e.op === '<=') return na <= nb;
      if (e.op === '>') return na > nb;
      return na >= nb;
    }
  }
}

/** Evaluates a condition against the run's scope. Throws `ExprError` when it does not parse. */
export function evaluateCondition(src: string, scope: Record<string, unknown>): boolean {
  return truthy(evalNode(parseExpr(src), scope));
}

/** Step ids a condition reads (`steps.<id>…`), to check they come earlier in the automation. */
export function referencedSteps(e: Expr): string[] {
  const out = new Set<string>();
  const walk = (n: Expr) => {
    if (n.k === 'path' && n.parts[0] === 'steps' && n.parts[1]) out.add(n.parts[1]);
    else if (n.k === 'call') n.args.forEach(walk);
    else if (n.k === 'not') walk(n.e);
    else if (n.k === 'bin') {
      walk(n.a);
      walk(n.b);
    }
  };
  walk(e);
  return [...out];
}
