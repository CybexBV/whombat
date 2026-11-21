import { describe, expect, it } from 'vitest';
import {
  type KioskOutput,
  mainLogical,
  monitorLogical,
  outputKey,
  outputsFromHash,
  placeOutputs,
  sizeReport,
} from './outputs';

/** The fragment the kiosk writes: base64url JSON, without padding. */
const fragment = (outputs: unknown) =>
  `#t=tok-abcdefgh&o=${btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(outputs))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')}`;

const z13 = { n: 'eDP-1', m: 'TL134ADXP01', x: 0, y: 0, w: 2560, h: 1600, mw: 286, mh: 179 };
const dell = { n: 'HDMI-A-1', m: 'DELL U2720Q', x: 2560, y: 0, w: 1920, h: 1080, mw: 527, mh: 296 };

describe('the outputs the kiosk names', () => {
  it('reads them from the fragment, beside the token', () => {
    const o = outputsFromHash(fragment([z13, dell]));
    expect(o).toEqual([
      {
        name: 'eDP-1',
        model: 'TL134ADXP01',
        x: 0,
        y: 0,
        width: 2560,
        height: 1600,
        mmWidth: 286,
        mmHeight: 179,
      },
      {
        name: 'HDMI-A-1',
        model: 'DELL U2720Q',
        x: 2560,
        y: 0,
        width: 1920,
        height: 1080,
        mmWidth: 527,
        mmHeight: 296,
      },
    ]);
  });

  it('leaves out what isn’t an output, and is none without one', () => {
    expect(
      outputsFromHash(
        fragment([
          { ...dell, n: 'HDMI A 1' },
          { ...dell, w: 0 },
          { ...dell, x: 1.5 },
          { ...dell, m: ' Odd‮\nname ', mw: -1 },
        ]),
      ),
    ).toEqual([
      {
        name: 'HDMI-A-1',
        model: 'Odd name',
        x: 2560,
        y: 0,
        width: 1920,
        height: 1080,
        mmWidth: 0,
        mmHeight: 296,
      },
    ]);
    expect(outputsFromHash('#t=tok-abcdefgh')).toBeNull();
    expect(outputsFromHash('#t=tok-abcdefgh&o=%%%')).toBeNull();
    expect(outputsFromHash(fragment({ n: 'eDP-1' }))).toBeNull();
    expect(outputsFromHash(fragment([]))).toBeNull();
  });

  it('keys them as the contract does', () => {
    expect(outputKey('eDP-1')).toBe('edp-1');
    expect(outputKey('HDMI-A-1')).toBe('hdmi-a-1');
    expect(outputKey('Virtual_1')).toBe('virtual-1');
  });
});

describe('logical sizes', () => {
  it('draws the box’s own display on the desk’s stage', () => {
    expect(mainLogical(2560, 1600)).toEqual({ width: 1280, height: 800 });
    expect(mainLogical(1920, 1080)).toEqual({ width: 1422, height: 800 });
    expect(mainLogical(1280, 800)).toEqual({ width: 1280, height: 800 });
  });

  it('shows a monitor at about 96 pixels an inch, in quarter steps', () => {
    const mon = (width: number, height: number, mmWidth: number, mmHeight: number) =>
      monitorLogical({ width, height, mmWidth, mmHeight });
    // 24″ 1080p: as it is (12 × 7 cells).
    expect(mon(1920, 1080, 531, 299)).toEqual({ width: 1920, height: 1080 });
    // 27″ 4K: 163 ppi, 1.75.
    expect(mon(3840, 2160, 597, 336)).toEqual({ width: 2194, height: 1234 });
    // 27″ 1440p: 109 ppi, 1.25.
    expect(mon(2560, 1440, 597, 336)).toEqual({ width: 2048, height: 1152 });
    // A TV without a believable size (none, only its aspect, or the aspect's off): as if 1080p.
    expect(mon(3840, 2160, 0, 0)).toEqual({ width: 1920, height: 1080 });
    expect(mon(3840, 2160, 160, 90)).toEqual({ width: 1920, height: 1080 });
    expect(mon(3840, 2160, 160, 160)).toEqual({ width: 1920, height: 1080 });
    // A small dense one (7″, 169 ppi) as a phone would; never under the contract's 200.
    expect(mon(1024, 600, 154, 90)).toEqual({ width: 585, height: 343 });
    expect(mon(320, 120, 0, 0)).toEqual({ width: 320, height: 200 });
  });
});

describe('where each output sits in the window', () => {
  const kiosk = (...o: (typeof z13)[]): KioskOutput[] => outputsFromHash(fragment(o)) ?? [];

  it('is the whole window without the kiosk’s word, or with one output', () => {
    expect(placeOutputs({ width: 2560, height: 1600 }, null)).toEqual([
      {
        key: 'display',
        main: true,
        name: null,
        left: 0,
        top: 0,
        width: 2560,
        height: 1600,
        logical: { width: 1280, height: 800 },
      },
    ]);
    expect(placeOutputs({ width: 2560, height: 1600 }, kiosk(z13))[0]?.key).toBe('edp-1');
  });

  it('puts the box’s own panel first, the monitors after it, each in its rectangle', () => {
    const p = placeOutputs({ width: 4480, height: 1600 }, kiosk({ ...dell, x: 0 }, { ...z13, x: 1920 }));
    expect(p.map((o) => [o.key, o.main, o.name, o.left, o.top, o.width, o.height])).toEqual([
      ['edp-1', true, null, 1920, 0, 2560, 1600],
      ['hdmi-a-1', false, 'DELL U2720Q', 0, 0, 1920, 1080],
    ]);
    expect(p[1]?.logical).toEqual({ width: 1920, height: 1080 });
    expect(sizeReport(p)).toEqual({
      outputs: [
        { key: 'edp-1', main: true, name: null, size: { width: 1280, height: 800 } },
        { key: 'hdmi-a-1', main: false, name: 'DELL U2720Q', size: { width: 1920, height: 1080 } },
      ],
    });
  });

  it('takes the first the kiosk listed when none is a panel', () => {
    const p = placeOutputs(
      { width: 3840, height: 1080 },
      kiosk({ ...dell, n: 'DP-2', x: 1920 }, { ...dell, n: 'DP-1', x: 0, m: '' }),
    );
    expect(p.map((o) => [o.key, o.main, o.left, o.name])).toEqual([
      ['dp-2', true, 1920, null],
      ['dp-1', false, 0, null],
    ]);
  });

  it('is the whole window when the outputs don’t tile it', () => {
    // The window was resized since the kiosk started.
    expect(placeOutputs({ width: 2560, height: 1600 }, kiosk(z13, dell))).toHaveLength(1);
    // Mirrored.
    expect(placeOutputs({ width: 2560, height: 1600 }, kiosk(z13, { ...dell, x: 0 }))).toHaveLength(1);
  });

  it('reports at most four, each key once', () => {
    const many = [0, 1, 2, 3, 4].map((i) => ({ ...dell, n: i < 2 ? 'DP-1' : `DP-${i}`, x: i * 1920 }));
    const p = placeOutputs({ width: 5 * 1920, height: 1080 }, kiosk(...many));
    expect(p.map((o) => o.key)).toEqual(['dp-1', 'dp-1-2', 'dp-2', 'dp-3']);
  });
});
