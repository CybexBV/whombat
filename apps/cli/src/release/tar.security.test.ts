/**
 * Regression tests for the independent security review of Workstream F (SEC2-F1, SEC2-F2): the proof-of-concept
 * archives from `review/security2`, now refused. docs/decisions/bp-distribution.md BP-F12, BP-F14.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractTarGz, linkPassesThroughLink, parsePax, UnsafeArchiveError } from './tar';

const BASE = join(process.env.HOME || homedir(), '.cache', 'wb-tmp', 'sec2');
let dir: string;
beforeEach(() => {
  mkdirSync(BASE, { recursive: true });
  dir = mkdtempSync(join(BASE, 'tar-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A raw ustar header with a correct checksum; `size` is written verbatim (so it can be non-octal). */
function rawHeader(name: string, typeflag: string, opts: { size?: string; linkname?: string } = {}): Buffer {
  const b = Buffer.alloc(512);
  b.write(name, 0, 'utf8');
  b.write('0000644\0', 100);
  b.write('0000000\0', 108);
  b.write('0000000\0', 116);
  b.write(`${(opts.size ?? '00000000000').padEnd(11, '0').slice(0, 11)}\0`, 124);
  b.write('00000000000\0', 136);
  b.fill(' ', 148, 156);
  b.write(typeflag, 156);
  if (opts.linkname) b.write(opts.linkname, 157, 'utf8');
  b.write('ustar\0', 257);
  b.write('00', 263);
  let sum = 0;
  for (const x of b) sum += x;
  b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return b;
}

function paxBody(body: string): Buffer[] {
  const data = Buffer.from(body);
  const padded = Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  return [rawHeader('PaxHeader', 'x', { size: data.length.toString(8).padStart(11, '0') }), padded];
}

function pax(records: Record<string, string>): Buffer[] {
  let body = '';
  for (const [k, v] of Object.entries(records)) {
    const rest = ` ${k}=${v}\n`;
    let len = rest.length + 1;
    while (String(len).length + rest.length !== len) len = String(len).length + rest.length;
    body += `${len}${rest}`;
  }
  return paxBody(body);
}

function archive(name: string, blocks: Buffer[]): string {
  const file = join(dir, name);
  writeFileSync(file, gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])));
  return file;
}

describe('SEC2-F1: symlink chains', () => {
  // `l -> .` stays inside; `e -> l/..` normalizes to `.` (inside) — but on disk `l/..` is the parent of dest.
  const chain = () => [
    rawHeader('l', '2', { linkname: '.' }),
    rawHeader('e', '2', { linkname: 'l/..' }),
    rawHeader('home', '5'),
    rawHeader('home/files', '2', { linkname: '../e' }),
  ];

  it('an archive without links (a backup) refuses the first one', async () => {
    const dest = join(dir, 'stage');
    await expect(extractTarGz(archive('evil.tar.gz', chain()), dest)).rejects.toThrow(UnsafeArchiveError);
    expect(readdirSync(dest)).toEqual([]);
  });

  it('even where links are allowed, a link through another link is refused', async () => {
    const dest = join(dir, 'stage');
    await expect(
      extractTarGz(archive('evil.tar.gz', chain()), dest, { allowLink: () => true }),
    ).rejects.toThrow(/goes through another link|points outside/);
    // Nothing that resolves above the destination was made.
    expect(existsSync(join(dest, 'e'))).toBe(false);
    expect(existsSync(join(dest, 'home', 'files'))).toBe(false);
  });

  it('a link made later on an earlier link’s way is caught after unpacking', async () => {
    // `a -> x/y` is fine when it is made; `x -> sub` then puts a link on its way.
    const blocks = [
      rawHeader('sub', '5'),
      rawHeader('sub/y', '0', { size: '00000000001' }),
      Buffer.concat([Buffer.from('y'), Buffer.alloc(511)]),
      rawHeader('a', '2', { linkname: 'x/y' }),
      rawHeader('x', '2', { linkname: 'sub' }),
    ];
    await expect(
      extractTarGz(archive('late.tar.gz', blocks), join(dir, 'stage'), { allowLink: () => true }),
    ).rejects.toThrow(/goes through another link/);
  });

  it('a link to nothing, or to a link, is refused', async () => {
    await expect(
      extractTarGz(
        archive('dangling.tar.gz', [rawHeader('a', '2', { linkname: 'nothing' })]),
        join(dir, 's1'),
        {
          allowLink: () => true,
        },
      ),
    ).rejects.toThrow(/points at nothing/);
    expect(linkPassesThroughLink('b', 'a', new Set(['a']))).toBe(true);
    expect(linkPassesThroughLink('d/b', '../a/c', new Set(['a']))).toBe(true);
    expect(linkPassesThroughLink('d/b', 'c', new Set(['a']))).toBe(false);
    expect(linkPassesThroughLink('b', '../x', new Set())).toBe(true);
  });
});

/**
 * Unpacks `file` in a child process: a size that parses to NaN used to spin forever (100% CPU), so a regression
 * must fail the test, not hang the suite. Resolves with what the child printed, or null when it didn't finish.
 */
async function extractInChild(file: string): Promise<string | null> {
  const tar = join(import.meta.dirname, 'tar.ts').replaceAll('\\', '/');
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}`);
  const script = `import('${tar}').then(m => m.extractTarGz(${JSON.stringify(file)}, ${JSON.stringify(out)})).then(() => { console.log('DONE'); process.exit(0) }, e => { console.log('ERR ' + e.message); process.exit(0) })`;
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  child.stdout.on('data', (c) => {
    text += String(c);
  });
  const finished = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 15_000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  child.kill('SIGKILL');
  return finished ? text.trim() : null;
}

describe('SEC2-F2: sizes that don’t parse', () => {
  it('a non-octal header size is a damaged archive, not an endless loop', async () => {
    const file = archive('hang.tar.gz', [
      rawHeader('a', '0', { size: '99999999999' }),
      Buffer.alloc(512, 0x41),
    ]);
    expect(await extractInChild(file)).toBe('ERR corrupt archive (the size field isn’t a number)');
  }, 30_000);

  it('a pax size that isn’t a whole number is refused', async () => {
    for (const size of ['abc', '1.5', '1e3', ''])
      expect(
        await extractInChild(
          archive(`p-${size || 'empty'}.tar.gz`, [...pax({ size }), rawHeader('f', '0'), Buffer.alloc(512)]),
        ),
      ).toBe('ERR corrupt archive (a pax size isn’t a valid number)');
  }, 60_000);

  it('a negative pax size is refused before anything is written', async () => {
    const body = Buffer.alloc(256 * 1024, 0x42);
    const file = archive('neg.tar.gz', [
      ...pax({ size: '-1' }),
      rawHeader('big', '0', { size: '00000000001' }),
      body,
    ]);
    const out = join(dir, 'out');
    await expect(extractTarGz(file, out, { maxBytes: 1024 })).rejects.toThrow(
      /a pax size isn’t a valid number/,
    );
    expect(existsSync(join(out, 'big')) ? statSync(join(out, 'big')).size : 0).toBeLessThanOrEqual(1024);
  });

  it('a pax size past 2^53, and records that don’t parse, are refused', async () => {
    await expect(
      extractTarGz(
        archive('p-huge.tar.gz', [...pax({ size: '9007199254740993' }), rawHeader('f', '0')]),
        join(dir, 'o-huge'),
      ),
    ).rejects.toThrow(/a pax size isn’t a valid number/);
    expect(() => parsePax(Buffer.from('12 path=abc'))).toThrow(/doesn’t parse/); // no newline
    expect(() => parsePax(Buffer.from('99 path=abc\n'))).toThrow(/doesn’t parse/); // longer than the data
    expect(() => parsePax(Buffer.from('x path=abc\n'))).toThrow(/doesn’t parse/);
    expect(() => parsePax(Buffer.from('9 noeq12\n'))).toThrow(/doesn’t parse/);
    expect(parsePax(Buffer.concat([Buffer.from('12 path=abc\n'), Buffer.alloc(20)]))).toEqual({
      path: 'abc',
    });
    await expect(
      extractTarGz(archive('rec.tar.gz', [...paxBody('garbage'), rawHeader('f', '0')]), join(dir, 'o-rec')),
    ).rejects.toThrow(/pax header record doesn’t parse/);
  });

  it('a mode or mtime that isn’t octal is refused too', async () => {
    const h = rawHeader('f', '0');
    h.write('0000z44\0', 100);
    h.fill(' ', 148, 156);
    let sum = 0;
    for (const x of h) sum += x;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    await expect(extractTarGz(archive('mode.tar.gz', [h]), join(dir, 'o'))).rejects.toThrow(
      /the mode field isn’t a number/,
    );
  });
});
