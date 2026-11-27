import { EN, NL } from './catalog';
import { formatLocale, isDutch, resolveLocale } from './locale';

export interface PluralMessage {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}
export type MessageCatalog = Readonly<Record<string, string | PluralMessage>>;
type Values = Readonly<Record<string, string | number | undefined>>;
export interface Translate {
  (key: keyof typeof EN, values?: Values): string;
  locale: string;
}

const HOLE = /\{([a-zA-Z][\w]*)\}/g;
const ACCENTS = 'áƀçðéƒĝĥîĵķļɱñöþɋŕšţûṽŵẋýž';

function pseudo(message: string): string {
  const accented = message.replace(/\{[a-zA-Z][\w]*\}|[a-z]/gi, (part) => {
    if (part.startsWith('{')) return part;
    const letter = ACCENTS[part.toLowerCase().charCodeAt(0) - 97] ?? part;
    return part === part.toUpperCase() ? letter.toUpperCase() : letter;
  });
  const width = message.replace(HOLE, '').length;
  return `[${accented}${'·'.repeat(Math.ceil(width / 4))}]`;
}

export function translator(tag?: string): Translate {
  const locale = resolveLocale(tag);
  const intl = formatLocale(locale);
  const plurals = new Intl.PluralRules(intl);
  const numbers = new Intl.NumberFormat(intl);
  const catalog: MessageCatalog = isDutch(locale) ? NL : EN;
  const english: MessageCatalog = EN;
  return Object.assign(
    (key: keyof typeof EN, values?: Values) => {
      const entry = catalog[key] ?? english[key];
      if (entry === undefined) return key;
      const count = typeof values?.count === 'number' ? values.count : 0;
      const message = typeof entry === 'string' ? entry : (entry[plurals.select(count)] ?? entry.other);
      return (locale === 'pseudo' ? pseudo(message) : message).replace(HOLE, (hole, name: string) => {
        const value = values && Object.hasOwn(values, name) ? values[name] : undefined;
        return typeof value === 'number' && isDutch(locale)
          ? numbers.format(value)
          : value === undefined
            ? hole
            : String(value);
      });
    },
    { locale },
  );
}

export const english = translator();

export function localized<T>(build: (t: Translate) => T): (t?: Translate) => T {
  const cache = new WeakMap<Translate, T>();
  return (t = english) => {
    const cached = cache.get(t);
    if (cached !== undefined) return cached;
    const value = build(t);
    cache.set(t, value);
    return value;
  };
}
