/**
 * Every CSS-module class the web and widget code reads exists in the module it reads it from.
 *
 * Vitest answers any `styles.x` with `"x"`, so a class the code names but the stylesheet lacks (deleted, misspelt, or
 * written `pill_ok` where the build's `camelCaseOnly` naming makes it `pillOk`) passes every unit test and shows as an
 * unstyled element in the app. This reads each module's class names the way the build does (Vite's own CSS-module
 * transform with `camelCaseOnly`) and each lookup the code makes:
 *
 * - `styles.x`, `styles['x']`, `styles[c ? 'x' : 'y']` and `const { x } = styles`: `x` must exist;
 * - `styles[\`pill${…}\`]` and `variantClass(styles, 'pill', key)`: some class must start with the fixed part;
 * - `export { styles as frameStyles }`: the same lookups in the files that import `frameStyles`.
 *
 * A key computed entirely at run time (`styles[name]`) is skipped. Unused classes are not this check's business.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseSync, preprocessCSS, resolveConfig } from 'vite';

/**
 * Where the code that uses CSS modules lives, relative to the repository root. A folder that isn't there is skipped.
 */
export const SOURCE_DIRS = ['apps/web/src', 'apps/widget/src'];

/** One lookup of a class the module doesn't define. */
export interface Finding {
  /** `path:line`, relative to the root. */
  where: string;
  /** What the code reads, as written (`styles.dotNew`, `variantClass(styles, 'pill', …)`). */
  lookup: string;
  /** The stylesheet, relative to the root. */
  module: string;
}

export const describeFinding = (f: Finding) => `${f.where}: ${f.lookup} is not a class in ${f.module}`;

type Node = { type: string; start: number; end: number; [key: string]: unknown };

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';

const child = (node: Node, key: string): Node | undefined => {
  const value = node[key];
  return isNode(value) ? value : undefined;
};

const stringLiteral = (node: Node | undefined): string | undefined =>
  node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;

const identifierName = (node: Node | undefined): string | undefined => {
  if (node?.type === 'Identifier') return node.name as string;
  return stringLiteral(node);
};

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, out);
    else out.push(path);
  }
  return out;
}

/** Names a binding pattern declares (`a`, `{ a, b: c }`, `[d, ...e]`, `f = 1`). */
function patternNames(node: Node | undefined, out: string[] = []): string[] {
  if (!node) return out;
  switch (node.type) {
    case 'Identifier':
      out.push(node.name as string);
      break;
    case 'ObjectPattern':
      for (const prop of node.properties as Node[])
        patternNames(prop.type === 'RestElement' ? child(prop, 'argument') : child(prop, 'value'), out);
      break;
    case 'ArrayPattern':
      for (const element of node.elements as (Node | null)[]) patternNames(element ?? undefined, out);
      break;
    case 'AssignmentPattern':
      patternNames(child(node, 'left'), out);
      break;
    case 'RestElement':
      patternNames(child(node, 'argument'), out);
      break;
    case 'TSParameterProperty':
      patternNames(child(node, 'parameter'), out);
      break;
  }
  return out;
}

/** Names a node declares for the scope it opens: a function's parameters, a block's own declarations. */
function scopeNames(node: Node): string[] {
  const names: string[] = [];
  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  ) {
    for (const param of node.params as Node[]) patternNames(param, names);
  }
  if (node.type === 'CatchClause') patternNames(child(node, 'param'), names);
  const body =
    node.type === 'BlockStatement' || node.type === 'StaticBlock'
      ? (node.body as Node[])
      : node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement'
        ? [child(node, node.type === 'ForStatement' ? 'init' : 'left')].filter(isNode)
        : [];
  for (const statement of body) {
    if (statement.type === 'VariableDeclaration')
      for (const d of statement.declarations as Node[]) patternNames(child(d, 'id'), names);
    if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration')
      patternNames(child(statement, 'id'), names);
  }
  return names;
}

/** A use of a stylesheet's object the check can judge: an exact class name or the fixed start of one. */
type Lookup = { at: number; text: string } & ({ name: string } | { prefix: string });

interface Holder {
  /** The stylesheet whose classes the binding holds. */
  css: string;
  /** Exact names imported from it (`import { a } from './x.module.css'`), or the whole object. */
  only?: string;
}

/** Visits a file's tree with the local names that hold a stylesheet's object, outside places that shadow them. */
function lookupsIn(
  program: Node,
  source: string,
  holders: Map<string, Holder>,
  onLookup: (holder: Holder, lookup: Lookup) => void,
  onExport: (holder: Holder, exported: string) => void,
) {
  const snippet = (node: Node) => source.slice(node.start, node.end).replace(/\s+/g, ' ');
  const visit = (node: Node, parent: Node | undefined, shadowed: Set<string>) => {
    const own = scopeNames(node).filter((name) => holders.has(name));
    const inner = own.length ? new Set([...shadowed, ...own]) : shadowed;
    if (
      node.type === 'Identifier' &&
      parent &&
      holders.has(node.name as string) &&
      !inner.has(node.name as string)
    ) {
      const holder = holders.get(node.name as string) as Holder;
      judge(node, parent, holder);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type') continue;
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item, node, inner);
      } else if (isNode(value)) visit(value, node, inner);
    }
  };
  const judge = (ref: Node, parent: Node, holder: Holder) => {
    if (holder.only !== undefined) {
      // A class imported by name is checked where it is imported.
      return;
    }
    if (parent.type === 'MemberExpression' && parent.object === ref) {
      const property = child(parent, 'property') as Node;
      if (!parent.computed) {
        onLookup(holder, { at: parent.start, text: snippet(parent), name: property.name as string });
        return;
      }
      for (const lookup of keyLookups(property))
        onLookup(holder, { at: parent.start, text: snippet(parent), ...lookup });
      return;
    }
    if (
      parent.type === 'CallExpression' &&
      identifierName(child(parent, 'callee')) === 'variantClass' &&
      (parent.arguments as Node[])[0] === ref
    ) {
      const [, base, key] = parent.arguments as Node[];
      const prefix = stringLiteral(base);
      if (prefix === undefined) return;
      const exact = stringLiteral(key);
      // variantClass joins the base and the key with the key's first letter in capitals.
      const lookup =
        exact === undefined
          ? { prefix }
          : { name: `${prefix}${exact.charAt(0).toUpperCase()}${exact.slice(1)}` };
      onLookup(holder, { at: parent.start, text: snippet(parent), ...lookup });
      return;
    }
    if (
      parent.type === 'VariableDeclarator' &&
      parent.init === ref &&
      child(parent, 'id')?.type === 'ObjectPattern'
    ) {
      for (const prop of (child(parent, 'id') as Node).properties as Node[]) {
        if (prop.type !== 'Property' || prop.computed) continue;
        const name = identifierName(child(prop, 'key'));
        if (name) onLookup(holder, { at: prop.start, text: `{ ${name} } = ${snippet(ref)}`, name });
      }
      return;
    }
    if (parent.type === 'ExportSpecifier' && parent.local === ref) {
      const exported = identifierName(child(parent, 'exported'));
      if (exported) onExport(holder, exported);
    }
  };
  visit(program, undefined, new Set());
}

/** What a computed key can be: exact names (`'x'`, `c ? 'x' : 'y'`, `` `x` ``) or a fixed start (`` `pill${…}` ``). */
function keyLookups(key: Node): ({ name: string } | { prefix: string })[] {
  const exact = stringLiteral(key);
  if (exact !== undefined) return [{ name: exact }];
  if (key.type === 'TemplateLiteral') {
    const quasis = key.quasis as Node[];
    const first = ((quasis[0]?.value as { cooked?: string } | undefined)?.cooked ?? '') as string;
    if (quasis.length === 1) return [{ name: first }];
    return first ? [{ prefix: first }] : [];
  }
  if (key.type === 'ConditionalExpression') {
    const branches = [child(key, 'consequent'), child(key, 'alternate')].map(stringLiteral);
    if (branches.every((b) => b !== undefined)) return (branches as string[]).map((name) => ({ name }));
  }
  if (
    key.type === 'TSAsExpression' ||
    key.type === 'TSSatisfiesExpression' ||
    key.type === 'ParenthesizedExpression'
  )
    return keyLookups(child(key, 'expression') as Node);
  return [];
}

/** Each module's class names as the build exports them (`camelCaseOnly`, as the apps' Vite configs set). */
async function moduleClasses(root: string, files: string[]): Promise<Map<string, Set<string>>> {
  const config = await resolveConfig(
    { configFile: false, logLevel: 'silent', root, css: { modules: { localsConvention: 'camelCaseOnly' } } },
    'build',
  );
  const entries = await Promise.all(
    files.map(async (file) => {
      const result = await preprocessCSS(readFileSync(file, 'utf8'), file, config);
      return [file, new Set(Object.keys(result.modules ?? {}))] as const;
    }),
  );
  return new Map(entries);
}

/** The lookups of undefined classes under `dirs` (relative to `root`), in file and line order. */
export async function findUndefinedClasses(root: string, dirs: string[] = SOURCE_DIRS): Promise<Finding[]> {
  const files = dirs.flatMap((dir) => walkFiles(join(root, dir)));
  const code = files.filter((f) => /\.(tsx?|mts)$/.test(f) && !f.endsWith('.d.ts'));
  const sources = new Map(code.map((f) => [f, readFileSync(f, 'utf8')]));
  const programs = new Map<string, Node>();
  const programOf = (file: string) => {
    let program = programs.get(file);
    if (!program) {
      program = parseSync(file, sources.get(file) as string, { lang: file.endsWith('x') ? 'tsx' : 'ts' })
        .program as unknown as Node;
      programs.set(file, program);
    }
    return program;
  };
  const resolveCode = (from: string, spec: string) => {
    if (!spec.startsWith('.')) return undefined;
    const base = resolve(dirname(from), spec.replace(/\.js$/, ''));
    return [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')].find((c) =>
      sources.has(c),
    );
  };
  const lineOf = (file: string, offset: number) => {
    const text = sources.get(file) as string;
    let line = 1;
    for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
    return line;
  };

  const findings: Finding[] = [];
  const cssFiles = new Set<string>();
  /** Per file, the local names bound to a stylesheet's object, from imports of a stylesheet or of a re-export. */
  const holdersByFile = new Map<string, Map<string, Holder>>();
  /** Re-exports: file → exported name → holder. */
  const exportsByFile = new Map<string, Map<string, Holder>>();
  const pendingNamed: { file: string; at: number; css: string; name: string }[] = [];

  for (const file of code) {
    const holders = new Map<string, Holder>();
    for (const statement of programOf(file).body as Node[]) {
      const declaration =
        statement.type === 'ImportDeclaration' ||
        (statement.type === 'ExportNamedDeclaration' && statement.source) ||
        statement.type === 'ExportAllDeclaration'
          ? statement
          : undefined;
      const spec = stringLiteral(child(declaration ?? statement, 'source'));
      if (!declaration || !spec?.endsWith('.module.css')) continue;
      const css = resolve(dirname(file), spec);
      cssFiles.add(css);
      for (const specifier of (declaration.specifiers ?? []) as Node[]) {
        const local = child(specifier, 'local') as Node;
        if (specifier.type === 'ImportDefaultSpecifier' || specifier.type === 'ImportNamespaceSpecifier')
          holders.set(local.name as string, { css });
        else if (specifier.type === 'ImportSpecifier') {
          const name = identifierName(child(specifier, 'imported')) as string;
          if (name === 'default') holders.set(local.name as string, { css });
          else pendingNamed.push({ file, at: specifier.start, css, name });
        } else if (specifier.type === 'ExportSpecifier') {
          const name = identifierName(local) as string;
          const exported = identifierName(child(specifier, 'exported')) as string;
          if (name === 'default') {
            const map = exportsByFile.get(file) ?? new Map<string, Holder>();
            map.set(exported, { css });
            exportsByFile.set(file, map);
          } else pendingNamed.push({ file, at: specifier.start, css, name });
        }
      }
    }
    if (holders.size) holdersByFile.set(file, holders);
  }

  const classes = await moduleClasses(
    root,
    [...cssFiles].filter((f) => existsSync(f)),
  );
  const rel = (file: string) => relative(root, file);
  const report = (file: string, at: number, lookup: string, css: string) =>
    findings.push({ where: `${rel(file)}:${lineOf(file, at)}`, lookup, module: rel(css) });

  for (const css of cssFiles)
    if (!classes.has(css))
      for (const [file, holders] of holdersByFile)
        for (const holder of holders.values())
          if (holder.css === css) report(file, 0, `the stylesheet ${rel(css)}`, css);
  for (const { file, at, css, name } of pendingNamed)
    if (classes.get(css) && !classes.get(css)?.has(name)) report(file, at, `{ ${name} }`, css);

  // Files whose stylesheet objects are known; a re-export adds its importers to the queue.
  const queue = [...holdersByFile.keys()];
  for (const [file] of exportsByFile) queue.push(file);
  const queued = new Set(queue);
  const enqueueImportersOf = (exporter: string) => {
    const exported = exportsByFile.get(exporter);
    if (!exported) return;
    for (const file of code) {
      const holders = holdersByFile.get(file) ?? new Map<string, Holder>();
      let added = false;
      for (const statement of programOf(file).body as Node[]) {
        if (statement.type !== 'ImportDeclaration') continue;
        const spec = stringLiteral(child(statement, 'source'));
        if (!spec || resolveCode(file, spec) !== exporter) continue;
        for (const specifier of statement.specifiers as Node[]) {
          if (specifier.type !== 'ImportSpecifier') continue;
          const holder = exported.get(identifierName(child(specifier, 'imported')) as string);
          const local = (child(specifier, 'local') as Node).name as string;
          if (holder && !holders.has(local)) {
            holders.set(local, holder);
            added = true;
          }
        }
      }
      if (added) {
        holdersByFile.set(file, holders);
        if (!queued.has(file)) {
          queued.add(file);
          queue.push(file);
        }
      }
    }
  };

  const done = new Map<string, Set<string>>();
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i] as string;
    const holders = holdersByFile.get(file);
    if (holders) {
      // A file can be revisited when a re-export gives it another name; judge each name once.
      const seen = done.get(file) ?? new Set<string>();
      const fresh = new Map([...holders].filter(([name]) => !seen.has(name)));
      for (const name of fresh.keys()) seen.add(name);
      done.set(file, seen);
      lookupsIn(
        programOf(file),
        sources.get(file) as string,
        fresh,
        (holder, lookup) => {
          const names = classes.get(holder.css);
          if (!names) return;
          const ok =
            'name' in lookup
              ? names.has(lookup.name)
              : [...names].some((n) => n.startsWith(lookup.prefix) && n.length > lookup.prefix.length);
          if (!ok) report(file, lookup.at, lookup.text, holder.css);
        },
        (holder, exported) => {
          const map = exportsByFile.get(file) ?? new Map<string, Holder>();
          map.set(exported, holder);
          exportsByFile.set(file, map);
        },
      );
    }
    enqueueImportersOf(file);
  }

  return findings.sort((a, b) => a.where.localeCompare(b.where, 'en', { numeric: true }));
}
