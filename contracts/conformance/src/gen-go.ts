/**
 * Go bindings generator (CT-09): Go types from the Zod definitions of the cross-language registry (inside
 * the supported subset), plus constants. Validation in Go uses the exported JSON Schema (embedded) through
 * `santhosh-tekuri/jsonschema`, so both languages enforce the same bounds.
 */
import * as control from '@whombat/control-contracts/device';
import * as local from '@whombat/control-contracts/local';
import * as protocol from '@whombat/protocol';
import * as release from '@whombat/release';
import type { z } from 'zod';
import { GO_PACKAGES, type GoPackage, REGISTRY } from './registry.ts';

type Def = { type: string; [k: string]: unknown };
const defOf = (s: unknown): Def => (s as { _zod: { def: Def } })._zod.def;
const isZod = (v: unknown): v is z.ZodType => typeof v === 'object' && v !== null && '_zod' in v;

const INITIALISMS = new Set(['id', 'url', 'ttl', 'json', 'api', 'sha256', 'jws', 'jwk', 'jwks', 'abi']);

export function goName(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s._-]+/)
    .filter(Boolean);
  return words
    .map((w) => (INITIALISMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
}

interface Named {
  name: string;
  pkg: GoPackage;
}

function buildNames(): Map<object, Named> {
  const names = new Map<object, Named>();
  for (const e of REGISTRY) if (!names.has(e.schema)) names.set(e.schema, { name: e.name, pkg: e.go });
  const sources: [Record<string, unknown>, GoPackage][] = [
    [protocol, 'protocol'],
    [release, 'release'],
    [control, 'device'],
    [local, 'local'],
  ];
  for (const [mod, pkg] of sources)
    for (const [name, value] of Object.entries(mod)) {
      if (!isZod(value) || names.has(value)) continue;
      const t = defOf(value).type;
      if (t === 'object' || t === 'enum') names.set(value, { name, pkg });
    }
  return names;
}

interface PkgOut {
  decls: string[];
  declared: Set<string>;
  imports: Set<string>;
  parse: string[];
}

export function generateGo(modulePath: string): Record<GoPackage, string> {
  const names = buildNames();
  const out = Object.fromEntries(
    GO_PACKAGES.map((p) => [p, { decls: [], declared: new Set(), imports: new Set(), parse: [] } as PkgOut]),
  ) as Record<GoPackage, PkgOut>;
  const pending: [z.ZodType, string, GoPackage][] = [];

  const ref = (from: GoPackage, named: Named) => {
    if (named.pkg === from) return named.name;
    out[from].imports.add(`${modulePath}/${named.pkg}`);
    return `${named.pkg}.${named.name}`;
  };

  /** Go type expression for a schema used in package `pkg`, declaring named types as needed. */
  const typeOf = (s: z.ZodType, suggested: string, pkg: GoPackage): string => {
    const d = defOf(s);
    switch (d.type) {
      case 'string':
        return 'string';
      case 'number':
        return 'int64';
      case 'boolean':
        return 'bool';
      case 'literal': {
        const v = (d.values as unknown[])[0];
        return typeof v === 'string' ? 'string' : typeof v === 'number' ? 'int64' : 'bool';
      }
      case 'enum': {
        const named = names.get(s);
        if (!named) return 'string';
        declareEnum(s, named);
        return ref(pkg, named);
      }
      case 'array':
        return `[]${typeOf(d.element as z.ZodType, `${suggested}Item`, pkg)}`;
      case 'record':
        out[pkg].imports.add('encoding/json');
        return 'json.RawMessage';
      case 'nullable': {
        const inner = typeOf(d.innerType as z.ZodType, suggested, pkg);
        return inner.startsWith('[]') || inner === 'json.RawMessage' ? inner : `*${inner}`;
      }
      case 'object': {
        const named = names.get(s) ?? { name: suggested, pkg };
        if (!names.has(s)) names.set(s, named);
        pending.push([s, named.name, named.pkg]);
        return ref(pkg, named);
      }
      case 'union': {
        const named = names.get(s);
        if (!named)
          throw new Error(`nested union at ${suggested} (only top-level registry unions are supported)`);
        return ref(pkg, named);
      }
      default:
        throw new Error(`unsupported ${d.type} at ${suggested}`);
    }
  };

  const declareEnum = (s: z.ZodType, named: Named) => {
    const o = out[named.pkg];
    if (o.declared.has(named.name)) return;
    o.declared.add(named.name);
    const values = Object.values(defOf(s).entries as Record<string, string>);
    o.decls.push(
      `// ${named.name} is one of ${values.map((v) => JSON.stringify(v)).join(', ')}.\ntype ${named.name} string\n\nconst (\n${values
        .map((v) => `\t${named.name}${goName(v)} ${named.name} = ${JSON.stringify(v)}`)
        .join(
          '\n',
        )}\n)\n\n// ${named.name}Values lists every ${named.name}.\nvar ${named.name}Values = []${named.name}{${values
        .map((v) => `${named.name}${goName(v)}`)
        .join(', ')}}`,
    );
  };

  const declareStruct = (s: z.ZodType, name: string, pkg: GoPackage) => {
    const o = out[pkg];
    if (o.declared.has(name)) return;
    o.declared.add(name);
    const shape = defOf(s).shape as Record<string, z.ZodType>;
    const fields = Object.entries(shape).map(([key, fs]) => {
      const fd = defOf(fs);
      const optional = fd.type === 'optional';
      const inner = optional ? (fd.innerType as z.ZodType) : fs;
      let t = typeOf(inner, `${name}${goName(key)}`, pkg);
      if (optional && !t.startsWith('[]') && t !== 'json.RawMessage') t = `*${t}`;
      const lit =
        defOf(inner).type === 'literal'
          ? ` // always ${JSON.stringify((defOf(inner).values as unknown[])[0])}`
          : '';
      return `\t${goName(key)} ${t} \`json:"${key}${optional ? ',omitempty' : ''}"\`${lit}`;
    });
    o.decls.push(`type ${name} struct {\n${fields.join('\n')}\n}`);
  };

  for (const e of REGISTRY) {
    const d = defOf(e.schema);
    const o = out[e.go];
    if (d.type === 'union') {
      const disc = d.discriminator as string;
      const options = (d.options as z.ZodType[]).map((opt) => {
        const named = names.get(opt);
        if (!named || named.pkg !== e.go)
          throw new Error(`${e.name}: union options must be registry objects`);
        typeOf(opt, named.name, e.go);
        const tag = ((defOf(opt).shape as Record<string, z.ZodType>)[disc] as z.ZodType)._zod
          .def as unknown as {
          values: string[];
        };
        return { name: named.name, tag: tag.values[0] as string };
      });
      o.imports.add('encoding/json');
      o.imports.add('fmt');
      o.decls.push(
        `// ${e.name} is one of ${options.map((x) => `*${x.name}`).join(', ')} (discriminated by "${disc}").\ntype ${e.name} interface{ is${e.name}() }\n\n${options
          .map((x) => `func (*${x.name}) is${e.name}() {}`)
          .join('\n')}`,
      );
      o.parse.push(
        `// Parse${e.name} validates data against the ${e.name} JSON Schema and decodes the matching variant.\nfunc Parse${e.name}(data []byte) (${e.name}, error) {\n\tif err := schemas.Validate("${e.name}", data); err != nil {\n\t\treturn nil, err\n\t}\n\tvar head struct {\n\t\tT string \`json:"${disc}"\`\n\t}\n\tif err := json.Unmarshal(data, &head); err != nil {\n\t\treturn nil, err\n\t}\n\tswitch head.T {\n${options
          .map((x) => `\tcase ${JSON.stringify(x.tag)}:\n\t\treturn Parse${x.name}(data)`)
          .join('\n')}\n\t}\n\treturn nil, fmt.Errorf("${e.name}: unknown ${disc} %q", head.T)\n}`,
      );
      o.parse.push(
        `var _ = register("${e.name}", func(data []byte) (any, error) { return Parse${e.name}(data) })`,
      );
      continue;
    }
    if (d.type !== 'object') throw new Error(`${e.name}: registry entries must be objects or unions`);
    const goType = typeOf(e.schema, e.name, e.go);
    if (goType !== e.name && !o.declared.has(e.name)) {
      // The same schema object is registered under several names (e.g. a shared `{ok: true}` response).
      o.declared.add(e.name);
      o.decls.push(`// ${e.name} is the same schema as ${goType}.\ntype ${e.name} = ${goType}`);
    }
    const validate =
      goType === e.name
        ? `\n\n// Validate checks v against the ${e.name} JSON Schema (as it would be sent).\nfunc (v *${e.name}) Validate() error { return schemas.ValidateValue("${e.name}", v) }`
        : '';
    o.parse.push(
      `// Parse${e.name} validates data against the ${e.name} JSON Schema and decodes it.\nfunc Parse${e.name}(data []byte) (*${e.name}, error) {\n\tv := new(${e.name})\n\tif err := schemas.Decode("${e.name}", data, v); err != nil {\n\t\treturn nil, err\n\t}\n\treturn v, nil\n}${validate}`,
    );
    o.parse.push(
      `var _ = register("${e.name}", func(data []byte) (any, error) { return Parse${e.name}(data) })`,
    );
  }
  while (pending.length) {
    const [s, name, pkg] = pending.shift() as [z.ZodType, string, GoPackage];
    declareStruct(s, name, pkg);
  }

  const files = {} as Record<GoPackage, string>;
  for (const pkg of GO_PACKAGES) {
    const o = out[pkg];
    o.imports.add(`${modulePath}/internal/schemas`);
    const imports = [...o.imports].sort(
      (a, b) => Number(a.includes('.')) - Number(b.includes('.')) || a.localeCompare(b),
    );
    const std = imports.filter((i) => !i.includes('.'));
    const ext = imports.filter((i) => i.includes('.'));
    files[pkg] =
      `// Code generated by conformance/src/gen-cross-language.ts from the Zod contracts. DO NOT EDIT.

package ${pkg}

import (
${std.map((i) => `\t"${i}"`).join('\n')}${std.length && ext.length ? '\n\n' : ''}${ext.map((i) => `\t"${i}"`).join('\n')}
)

${o.decls.join('\n\n')}

${o.parse.join('\n\n')}

// Parsers maps every schema name of this package to its parse function (used by the conformance tests).
var Parsers = map[string]func([]byte) (any, error){}

func register(name string, parse func([]byte) (any, error)) bool {
\tParsers[name] = parse
\treturn true
}
`;
  }
  return files;
}
