/**
 * Register values as numbers and back (docs/decisions/one-whombat-devices.md): the types a device profile names
 * (`u16`, `s16`, `u32`, `s32`, `f32`, `bool`), the word order of the 32-bit ones (`big`: the high word first, the
 * Modbus habit; `little`: the low word first) and a scale (the raw value times the scale is the reading: 215 × 0.1 =
 * 21.5 °C). Pure.
 */
export type RegisterType = 'u16' | 's16' | 'u32' | 's32' | 'f32' | 'bool';
export type WordOrder = 'big' | 'little';

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

/** How many 16-bit registers a value of the type takes. */
export function registersFor(type: RegisterType): 1 | 2 {
  return type === 'u32' || type === 's32' || type === 'f32' ? 2 : 1;
}

/** Rounds away the float noise of a scale (21.500000000000004 → 21.5). */
export function tidy(n: number): number {
  return Number.isFinite(n) ? Number.parseFloat(n.toPrecision(12)) : n;
}

function twoWords(words: readonly number[], order: WordOrder): Buffer {
  const [a, b] = order === 'big' ? [words[0], words[1]] : [words[1], words[0]];
  if (a === undefined || b === undefined) throw new ValueError('A 32-bit value needs two registers.');
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(a & 0xffff, 0);
  buf.writeUInt16BE(b & 0xffff, 2);
  return buf;
}

/** The value of `words` (or one bit) as the profile describes it, scaled. */
export function decodeRegisters(
  words: readonly number[],
  type: RegisterType,
  options: { wordOrder?: WordOrder; scale?: number } = {},
): number | boolean {
  const scale = options.scale ?? 1;
  const first = words[0];
  if (first === undefined) throw new ValueError('No register to read.');
  let raw: number;
  switch (type) {
    case 'bool':
      return first !== 0;
    case 'u16':
      raw = first & 0xffff;
      break;
    case 's16':
      raw = (first & 0xffff) >= 0x8000 ? (first & 0xffff) - 0x10000 : first & 0xffff;
      break;
    case 'u32':
      raw = twoWords(words, options.wordOrder ?? 'big').readUInt32BE(0);
      break;
    case 's32':
      raw = twoWords(words, options.wordOrder ?? 'big').readInt32BE(0);
      break;
    case 'f32':
      raw = twoWords(words, options.wordOrder ?? 'big').readFloatBE(0);
      if (!Number.isFinite(raw)) throw new ValueError('The register doesn’t hold a number.');
      // A 32-bit float holds about 7 significant digits: 1.2000000476837158 is 1.2.
      raw = Number.parseFloat(raw.toPrecision(7));
      break;
  }
  return tidy(raw * scale);
}

const BOUNDS: Record<Exclude<RegisterType, 'f32' | 'bool'>, [number, number]> = {
  u16: [0, 0xffff],
  s16: [-0x8000, 0x7fff],
  u32: [0, 0xffffffff],
  s32: [-0x80000000, 0x7fffffff],
};

/** The registers that hold `value` (unscaled first: 21.5 with scale 0.1 is 215). Throws `ValueError`. */
export function encodeRegisters(
  value: number | boolean,
  type: RegisterType,
  options: { wordOrder?: WordOrder; scale?: number } = {},
): number[] {
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw new ValueError('This setting is on or off.');
    return [value ? 1 : 0];
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ValueError('This setting is a number.');
  const scale = options.scale ?? 1;
  if (scale === 0 || !Number.isFinite(scale)) throw new ValueError('The profile’s scale is not usable.');
  const unscaled = value / scale;
  if (type === 'f32') {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(unscaled, 0);
    const words = [buf.readUInt16BE(0), buf.readUInt16BE(2)];
    return (options.wordOrder ?? 'big') === 'big' ? words : [words[1] as number, words[0] as number];
  }
  const raw = Math.round(unscaled);
  if (Math.abs(raw - unscaled) > 1e-6)
    throw new ValueError(`${value} can’t be set exactly; it goes in steps of ${tidy(scale)}.`);
  const [lo, hi] = BOUNDS[type];
  if (raw < lo || raw > hi) throw new ValueError(`${value} is outside what the device can hold.`);
  if (type === 'u16') return [raw];
  if (type === 's16') return [raw < 0 ? raw + 0x10000 : raw];
  const buf = Buffer.alloc(4);
  if (type === 'u32') buf.writeUInt32BE(raw, 0);
  else buf.writeInt32BE(raw, 0);
  const words = [buf.readUInt16BE(0), buf.readUInt16BE(2)];
  return (options.wordOrder ?? 'big') === 'big' ? words : [words[1] as number, words[0] as number];
}

/**
 * The value at a JSON pointer (RFC 6901: `/a/0/b`, `~1` is `/`, `~0` is `~`; `''` is the whole document), or
 * undefined when it isn't there.
 */
export function atPointer(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc;
  if (!pointer.startsWith('/')) return undefined;
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
      cur = cur[Number(key)];
    } else if (cur !== null && typeof cur === 'object') {
      if (!Object.hasOwn(cur, key)) return undefined;
      cur = (cur as Record<string, unknown>)[key];
    } else return undefined;
  }
  return cur;
}

/** A copy of `doc` with `value` at `pointer` (objects made on the way; arrays only by index). */
export function withPointer(doc: unknown, pointer: string, value: unknown): unknown {
  if (pointer === '') return value;
  const keys = pointer
    .slice(1)
    .split('/')
    .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
  const set = (cur: unknown, i: number): unknown => {
    const key = keys[i] as string;
    const last = i === keys.length - 1;
    if (Array.isArray(cur)) {
      const copy = [...cur];
      const at = Number(key);
      if (!Number.isInteger(at) || at < 0) throw new ValueError(`${pointer} isn’t a usable place.`);
      copy[at] = last ? value : set(copy[at], i + 1);
      return copy;
    }
    const obj = cur !== null && typeof cur === 'object' ? { ...(cur as Record<string, unknown>) } : {};
    obj[key] = last ? value : set(obj[key], i + 1);
    return obj;
  };
  return set(doc, 0);
}
