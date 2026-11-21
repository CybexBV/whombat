/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * - Object members sorted by UTF-16 code units (JavaScript's default string order), recursively.
 * - Numbers and strings serialised exactly like ECMAScript `JSON.stringify` (which JCS adopts);
 *   `-0` becomes `0`, NaN/Infinity are rejected.
 * - No whitespace.
 * - Lone surrogates are rejected (JCS requires valid Unicode).
 * - `undefined` object members are omitted (so optional fields may be absent or undefined);
 *   `undefined` anywhere else, functions, symbols, bigints, Dates and class instances are rejected.
 */

export class CanonicalJsonError extends TypeError {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path || '$'}`);
    this.name = 'CanonicalJsonError';
  }
}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function serializeString(s: string, path: string): string {
  if (hasLoneSurrogate(s)) throw new CanonicalJsonError('Lone surrogate in string', path);
  return JSON.stringify(s);
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError('Non-finite number', path);
      return JSON.stringify(value);
    case 'string':
      return serializeString(value, path);
    case 'object': {
      if (Array.isArray(value)) {
        const items = value.map((item, i) => {
          if (item === undefined) throw new CanonicalJsonError('undefined in array', `${path}[${i}]`);
          return serialize(item, `${path}[${i}]`);
        });
        return `[${items.join(',')}]`;
      }
      if (!isPlainObject(value)) throw new CanonicalJsonError('Only plain objects are allowed', path);
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort();
      const members = keys.map((k) => `${serializeString(k, path)}:${serialize(record[k], `${path}.${k}`)}`);
      return `{${members.join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`Unsupported value of type ${typeof value}`, path);
  }
}

/** Canonical JSON text of a JSON-compatible value. */
export function canonicalJson(value: unknown): string {
  return serialize(value, '');
}
