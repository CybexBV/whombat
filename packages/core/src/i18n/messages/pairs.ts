import type { MessageValue } from '../engine.js';

/** Messages written side by side: `key: [english, dutch]`. */
export type MessagePairs = Record<string, readonly [MessageValue, MessageValue]>;

/** Splits side-by-side pairs into the flat English and Dutch catalogs (plain data, built once at load). */
export function splitPairs<const T extends MessagePairs>(
  pairs: T,
): { en: { [K in keyof T]: T[K][0] }; nl: { [K in keyof T]: MessageValue } } {
  const en: Record<string, MessageValue> = {};
  const nl: Record<string, MessageValue> = {};
  for (const [key, [english, dutch]] of Object.entries(pairs)) {
    en[key] = english;
    nl[key] = dutch;
  }
  return { en, nl } as { en: { [K in keyof T]: T[K][0] }; nl: { [K in keyof T]: MessageValue } };
}
