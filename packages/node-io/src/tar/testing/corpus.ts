/** Independent, hand-built tar bytes shared by the three readers' behavior tests. No production writer here. */
export interface RawEntry {
  name?: string;
  type?: string;
  data?: Buffer;
  size?: number;
  prefix?: string;
  linkname?: string;
  fields?: readonly { offset: number; width: number; data: Buffer }[];
}

export function checksum(header: Buffer): Buffer {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

export function rawHeader(entry: RawEntry = {}): Buffer {
  const header = Buffer.alloc(512);
  header.write(entry.name ?? 'file', 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${(entry.size ?? entry.data?.length ?? 0).toString(8).padStart(11, '0')}\0`, 124, 12);
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write(entry.type ?? '0', 156, 1, 'ascii');
  header.write(entry.linkname ?? '', 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(entry.prefix ?? '', 345, 155, 'utf8');
  for (const field of entry.fields ?? []) {
    header.fill(0, field.offset, field.offset + field.width);
    field.data.copy(header, field.offset, 0, field.width);
  }
  return checksum(header);
}

export function rawEntry(entry: RawEntry = {}): Buffer {
  const data = entry.data ?? Buffer.alloc(0);
  return Buffer.concat([rawHeader(entry), data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

export function rawTar(entries: readonly Buffer[], end = true): Buffer {
  return Buffer.concat([...entries, ...(end ? [Buffer.alloc(1024)] : [])]);
}

/** Encode a positive GNU field independently of the parser. */
export function base256(value: bigint, width = 12): Buffer {
  const field = Buffer.alloc(width);
  for (let i = width - 1; i >= 0; i--) {
    field[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  field[0] = (field[0] ?? 0) | 0x80;
  return field;
}

export function paxBody(records: readonly [string, string][]): Buffer {
  return Buffer.concat(
    records.map(([key, value]) => {
      const body = Buffer.from(` ${key}=${value}\n`);
      let length = body.length + 1;
      for (;;) {
        const result = Buffer.concat([Buffer.from(String(length)), body]);
        if (result.length === length) return result;
        length = result.length;
      }
    }),
  );
}

export const fileData = Buffer.from('ok');
const file = () => rawEntry({ data: fileData });
const withField = (offset: number, width: number, data: Buffer) =>
  rawTar([rawEntry({ data: fileData, fields: [{ offset, width, data }] })]);
const withPax = (data: Buffer, type = 'x') => rawTar([rawEntry({ name: 'meta', type, data }), file()]);

export interface MalformedTarCase {
  name: string;
  bytes: () => Buffer;
  /** Null means accepted under this reader's existing compatibility policy. */
  releaseError: RegExp | null;
  clientError: RegExp | null;
  packError: RegExp | null;
}

export const malformedTarCases: readonly MalformedTarCase[] = [
  {
    name: 'bad checksum',
    bytes: () => {
      const bytes = rawTar([file()]);
      bytes[99] = 1; // Past the name's NUL, so its decoded path stays the same.
      return bytes;
    },
    releaseError: /bad header checksum/,
    clientError: /bad checksum/,
    packError: null,
  },
  {
    name: 'nonoctal checksum',
    bytes: () => {
      const bytes = rawTar([file()]);
      bytes.write('zzzzzz\0 ', 148, 8);
      return bytes;
    },
    releaseError: /checksum field isn’t a number/,
    clientError: /malformed header/,
    packError: null,
  },
  {
    name: 'nonoctal size',
    bytes: () => withField(124, 12, Buffer.from('99999999999\0')),
    releaseError: /size field isn’t a number/,
    clientError: /malformed header/,
    packError: /bad size field/,
  },
  {
    name: 'small GNU base-256 size',
    bytes: () => withField(124, 12, base256(2n)),
    releaseError: /size field isn’t a number/,
    clientError: null,
    packError: /too large to read/,
  },
  {
    name: 'unsafe GNU base-256 integer',
    bytes: () => withField(124, 12, base256(9007199254740992n)),
    releaseError: /size field isn’t a number/,
    clientError: /entry is too large/,
    packError: /too large to read/,
  },
  {
    name: 'negative GNU base-256 size',
    bytes: () => withField(124, 12, Buffer.alloc(12, 0xff)),
    releaseError: /size field isn’t a number/,
    clientError: /entry is too large/,
    packError: /too large to read/,
  },
  {
    name: 'numeric garbage after NUL',
    bytes: () => withField(124, 12, Buffer.from('2\0garbage')),
    releaseError: /size field isn’t a number/,
    clientError: null,
    packError: null,
  },
  ...[
    { name: 'invalid mode', offset: 100, width: 8, label: 'mode' },
    { name: 'invalid mtime', offset: 136, width: 12, label: 'mtime' },
  ].map(({ name, offset, width, label }) => ({
    name,
    bytes: () => withField(offset, width, Buffer.from('z')),
    releaseError: new RegExp(`${label} field isn’t a number`),
    clientError: null,
    packError: null,
  })),
  {
    name: 'PAX record extends past metadata',
    bytes: () => withPax(Buffer.from('99 path=file\n')),
    releaseError: /pax header record doesn’t parse/,
    clientError: /malformed pax header/,
    packError: null,
  },
  {
    name: 'PAX unframed tail',
    bytes: () => withPax(Buffer.from('garbage')),
    releaseError: /pax header record doesn’t parse/,
    clientError: null,
    packError: null,
  },
  {
    name: 'PAX missing newline',
    bytes: () => withPax(Buffer.from('13 path=file!')),
    releaseError: /pax header record doesn’t parse/,
    clientError: null,
    packError: null,
  },
  ...['-1', '1.5', '1e3', '', '9007199254740993'].map((size) => ({
    name: `invalid PAX size ${size || '(empty)'}`,
    bytes: () => withPax(paxBody([['size', size]])),
    releaseError: /pax size isn’t a valid number/,
    clientError: /malformed pax header/,
    packError: null, // Pack body boundaries use the ustar size, never PAX size.
  })),
  {
    name: 'PAX size with more than fifteen digits',
    bytes: () => withPax(paxBody([['size', '0000000000000002']])),
    releaseError: null,
    clientError: /malformed pax header/,
    packError: null,
  },
  {
    name: 'malformed global PAX',
    bytes: () => withPax(Buffer.from('garbage'), 'g'),
    releaseError: /pax header record doesn’t parse/,
    clientError: null,
    packError: null,
  },
  {
    name: 'truncated file body',
    bytes: () => Buffer.concat([rawHeader({ size: 2 }), Buffer.from('o')]),
    releaseError: /ends in the middle/,
    clientError: /ends early/,
    packError: /truncated/,
  },
  {
    name: 'missing end blocks',
    bytes: () => rawTar([file()], false),
    releaseError: /ends in the middle/,
    clientError: null,
    packError: null,
  },
  {
    name: 'missing final file padding',
    bytes: () => Buffer.concat([rawHeader({ data: fileData }), fileData]),
    releaseError: /ends in the middle/,
    clientError: null,
    packError: null,
  },
];
