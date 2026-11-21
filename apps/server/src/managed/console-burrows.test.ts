/** The console's burrows (CT-116, MR-78): making a display name from a burrow name, the builder and the frame filter. */
import { ConsoleDisplayText } from '@whombat/control-contracts/local';
import { describe, expect, it } from 'vitest';
import type { BusFrame } from '../realtime/bus';
import { changesBurrows, consoleBurrows, consoleDisplayName } from './console-burrows';

/** Invisible characters, spelled out so the source shows them. */
const NBSP = String.fromCharCode(0x00a0);
const IDEO_SPACE = String.fromCharCode(0x3000);
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const BOM = String.fromCharCode(0xfeff);
const ACUTE = String.fromCharCode(0x0301);
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);
const MVS = String.fromCharCode(0x180e);
const LS = String.fromCharCode(0x2028);

const valid = (s: string | null) => s !== null && ConsoleDisplayText.safeParse(s).success;

describe('consoleDisplayName', () => {
  it('keeps names in any script as they are', () => {
    for (const name of ['Dusty’s Burrow', 'Burrow HQ', '巣穴 🐻', 'מחילה', 'Café Wombat', 'B'])
      expect(consoleDisplayName(name)).toBe(name);
  });

  it('turns separators and line breaks into one space and trims the ends', () => {
    expect(consoleDisplayName(`  Dusty${NBSP}Burrow `)).toBe('Dusty Burrow');
    expect(consoleDisplayName('Dusty\n\tBurrow')).toBe('Dusty Burrow');
    expect(consoleDisplayName(`Dusty${LS}Burrow${IDEO_SPACE}HQ`)).toBe('Dusty Burrow HQ');
    expect(consoleDisplayName('Dusty    Burrow')).toBe('Dusty Burrow');
  });

  it('strips controls, escape sequences and format characters (bidi, zero-width)', () => {
    expect(consoleDisplayName('Dusty\u001b[2J Burrow')).toBe('Dusty[2J Burrow');
    expect(consoleDisplayName(`Dusty${RLO}worruB`)).toBe('DustyworruB');
    expect(consoleDisplayName(`Dus${ZWSP}ty${BOM}`)).toBe('Dusty');
    expect(consoleDisplayName('\u0085Dusty\u007f')).toBe('Dusty');
    expect(consoleDisplayName(`Dusty ${ZWSP} Burrow`)).toBe('Dusty Burrow');
  });

  it('cuts a name over 64 code points to 63 and “…”', () => {
    const cut = consoleDisplayName('🐻'.repeat(80));
    expect(cut).toBe(`${'🐻'.repeat(63)}…`);
    expect(Array.from(cut ?? '')).toHaveLength(64);
    expect(valid(cut)).toBe(true);
    expect(consoleDisplayName('a'.repeat(64))).toBe('a'.repeat(64));
    // No space before the ellipsis.
    expect(consoleDisplayName(`${'a'.repeat(62)} bcd`)).toBe(`${'a'.repeat(62)}…`);
  });

  it('gives null when nothing is left', () => {
    for (const name of ['', '   ', `${ZWSP}${RLO}`, '\u0000\u001b', `${NBSP}${IDEO_SPACE}`])
      expect(consoleDisplayName(name)).toBeNull();
  });

  it('always gives what the contract accepts', () => {
    const odd = [
      `${ACUTE}Dusty`,
      'a\ud800b',
      `x${LRI}y${PDI}`,
      `${' '.repeat(10)}${'é'.repeat(70)}`,
      `a${MVS}b`,
    ];
    for (const name of odd) {
      const shown = consoleDisplayName(name);
      expect(shown === null || valid(shown), JSON.stringify(name)).toBe(true);
    }
  });
});

describe('consoleBurrows', () => {
  it('names the oldest burrow and counts the others', () => {
    expect(consoleBurrows('Dusty’s Burrow', 1)).toEqual({ first: 'Dusty’s Burrow', more: 0 });
    expect(consoleBurrows('Dusty’s Burrow', 3)).toEqual({ first: 'Dusty’s Burrow', more: 2 });
    expect(consoleBurrows('HQ', 20_000)).toEqual({ first: 'HQ', more: 9999 });
  });

  it('leaves burrows out when there is none or the name has nothing to show', () => {
    expect(consoleBurrows(null, 0)).toBeUndefined();
    expect(consoleBurrows('HQ', 0)).toBeUndefined();
    expect(consoleBurrows(`${ZWSP}`, 2)).toBeUndefined();
  });
});

describe('changesBurrows', () => {
  const frame = (event: unknown): BusFrame =>
    ({
      topic: 'burrow:b1',
      event,
      eventId: null,
      at: '',
      outboxId: 1,
    }) as BusFrame;
  const audit = (type: string) => frame({ type: 'audit.appended', event: { type } });

  it('reacts to burrows created, renamed or removed, and to burrow updates', () => {
    for (const type of ['burrow.created', 'burrow.renamed', 'burrow.deleted', 'burrow.archived'])
      expect(changesBurrows(audit(type)), type).toBe(true);
    expect(changesBurrows(frame({ type: 'burrow.updated', burrow: {} }))).toBe(true);
  });

  it('ignores everything else', () => {
    expect(changesBurrows(audit('message.posted'))).toBe(false);
    expect(changesBurrows(audit('burrow.agents_lan_changed'))).toBe(false);
    expect(changesBurrows(frame({ type: 'typing' }))).toBe(false);
  });
});
