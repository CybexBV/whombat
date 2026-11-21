/**
 * What a socket entry says about its socket (docs/decisions/connections-more.md CM-13, CM-16; contracts' `SocketSpec`):
 * the dialect, the path, how Whombat signs in on it, and which methods read, stream or are never sent. Patterns are
 * regular expressions' sources matched against the whole method name, case-insensitively (core's `Pattern`). The
 * socket's own code works on the spec alone, without the entry or the database.
 */
import type { CatalogEntry, JsonValue } from '@whombat/core';

/** CM-13's `SocketSpec` as an entry carries it (defaults applied). */
export type SocketSpec = NonNullable<CatalogEntry['socket']>;

/** The socket's address from the base: `http:` → `ws:`, `https:` → `wss:` happens when it opens (`channel.ts`). */
export function socketHttpUrl(baseUrl: string, spec: Pick<SocketSpec, 'path'>): string {
  return `${baseUrl.replace(/\/+$/, '')}${spec.path}`;
}

/** What the login's templates are filled with: the secret and the connection's fields. */
export interface SocketLoginValues {
  secret: string;
  fields: Readonly<Record<string, string>>;
}

/**
 * The login's params with `{secret}` and `{field}` filled inside every string of the value (CM-13). Null when a value it
 * names is missing (an empty field, no secret).
 */
export function fillLoginParams(params: JsonValue, values: SocketLoginValues): JsonValue | null {
  let missing = false;
  const fill = (text: string): string =>
    text.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, id: string) => {
      const value = id === 'secret' ? values.secret : values.fields[id]?.trim();
      if (!value) {
        missing = true;
        return '';
      }
      return value;
    });
  const walk = (value: JsonValue): JsonValue => {
    if (typeof value === 'string') return fill(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v as JsonValue)]));
    return value;
  };
  const out = walk(params);
  return missing ? null : out;
}
