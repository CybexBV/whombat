import { ThingLogo } from '@whombat/core';
import svgpath from 'svgpath';
import { describe, expect, it } from 'vitest';
import { SVG_LOGO_BYTES_MAX, svgToLogo } from './svg';

function logo(svg: string): ThingLogo {
  const r = svgToLogo(svg);
  if (!r.ok) throw new Error(`expected a logo, got ${r.problem}`);
  // Every logo Whombat makes is one the apps accept.
  expect(ThingLogo.parse(r.logo)).toEqual(r.logo);
  return r.logo;
}

function problem(svg: string) {
  const r = svgToLogo(svg);
  if (r.ok) throw new Error('expected a problem');
  expect(r.message.length).toBeGreaterThan(10);
  return r.problem;
}

/** The absolute points a path passes through (end points of each segment). */
function points(d: string): [number, number][] {
  const out: [number, number][] = [];
  svgpath(d)
    .abs()
    .iterate((seg, _i, x, y) => {
      const s = seg as unknown as [string, ...number[]];
      const n = s.slice(1);
      if (s[0] === 'H') out.push([n[0] as number, y]);
      else if (s[0] === 'V') out.push([x, n[0] as number]);
      else if (n.length >= 2) out.push([n[n.length - 2] as number, n[n.length - 1] as number]);
    });
  return out;
}

const svg = (body: string, attrs = 'viewBox="0 0 24 24"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

describe('svgToLogo', () => {
  it('draws a Simple Icons style black icon as one shape in the text colour', () => {
    const l = logo(
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Example</title><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0z"/></svg>',
    );
    expect(l.viewBox).toBe('0 0 24 24');
    expect(l.shapes).toHaveLength(1);
    expect(l.shapes[0]?.fill).toBe('currentColor');
    expect(l.shapes[0]?.stroke).toBeUndefined();
  });

  it('keeps the colours of an Illustrator logo styled with classes', () => {
    const l = logo(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
  <!ENTITY ns_svg "http://www.w3.org/2000/svg">
]>
<svg id="Layer_1" data-name="Layer 1" xmlns="&ns_svg;" viewBox="0 0 100 50">
  <defs><style>.cls-1{fill:#FF6A00;}.cls-2{fill:#1a1a1a}.cls-2,.cls-3{opacity:.5}@media print{.cls-1{fill:red}}</style></defs>
  <!-- a comment -->
  <path class="cls-1" d="M0 0h40v40H0z"/>
  <path class="cls-2" d="M50 0h40v40H50z"/>
  <rect class="cls-1" x="0" y="45" width="10" height="5" style="fill:rgb(0, 128, 255)"/>
</svg>`);
    expect(l.viewBox).toBe('0 0 100 50');
    expect(l.shapes.map((s) => s.fill)).toEqual(['#ff6a00', '#1a1a1a', '#0080ff']);
    expect(l.shapes[1]?.opacity).toBe(0.5);
    expect(l.shapes[0]?.opacity).toBeUndefined();
  });

  it('turns rects, circles and polygons into paths', () => {
    const l = logo(
      svg(
        '<rect x="2" y="3" width="10" height="4" fill="#ff0000"/><circle cx="12" cy="12" r="5" fill="#00ff00"/><polygon points="0,0 10,0 5,8" fill="#0000ff"/><rect x="1" y="1" width="8" height="8" rx="2" fill="#123456"/>',
      ),
    );
    expect(l.shapes.map((s) => s.fill)).toEqual(['#ff0000', '#00ff00', '#0000ff', '#123456']);
    expect(points(l.shapes[0]?.d ?? '')).toEqual(
      expect.arrayContaining([
        [2, 3],
        [12, 3],
        [12, 7],
        [2, 7],
      ]),
    );
    const circle = points(l.shapes[1]?.d ?? '');
    expect(circle).toEqual(
      expect.arrayContaining([
        [17, 12],
        [7, 12],
      ]),
    );
    expect(l.shapes[1]?.d).toMatch(/a/i);
    expect(points(l.shapes[2]?.d ?? '')).toEqual(
      expect.arrayContaining([
        [0, 0],
        [10, 0],
        [5, 8],
      ]),
    );
    expect(l.shapes[3]?.d).toMatch(/a/i);
  });

  it('applies nested transforms, rotation and scale included', () => {
    const l = logo(
      svg(
        '<g transform="translate(10 0)"><g transform="rotate(90) scale(2)"><path d="M1 0L1 1" stroke="#ff0000" stroke-width="1" fill="none"/></g></g>',
        'viewBox="0 0 100 100"',
      ),
    );
    const shape = l.shapes[0];
    // (1,0) scaled to (2,0), turned to (0,2), moved to (10,2); (1,1) → (2,2) → (−2,2) → (8,2).
    const [a, b] = points(shape?.d ?? '');
    expect(a?.[0]).toBeCloseTo(10, 1);
    expect(a?.[1]).toBeCloseTo(2, 1);
    expect(b?.[0]).toBeCloseTo(8, 1);
    expect(b?.[1]).toBeCloseTo(2, 1);
    expect(shape?.strokeWidth).toBeCloseTo(2, 3);
    expect(shape?.fill).toBe('none');
    expect(shape?.stroke).toBe('#ff0000');
  });

  it('rotates around a centre and reads several steps in one transform', () => {
    const l = logo(
      svg('<path d="M12 2L12 3" stroke="#00aa00" transform="rotate(180 12 12), translate(0,1)"/>'),
    );
    const [a] = points(l.shapes[0]?.d ?? '');
    expect(a?.[0]).toBeCloseTo(12, 1);
    expect(a?.[1]).toBeCloseTo(21, 1);
  });

  it('draws a gradient as the colour at its middle', () => {
    const l = logo(
      svg(
        '<defs><linearGradient id="base"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient><linearGradient id="g" href="#base" x1="0" x2="1"/><radialGradient id="r"><stop stop-color="#000"/><stop style="stop-color:#00ff00;stop-opacity:0.5"/><stop stop-color="#fff"/></radialGradient></defs><path d="M0 0h10v10H0z" fill="url(#g)"/><path d="M12 12h10v10H12z" fill="url(\'#r\')"/>',
      ),
    );
    expect(l.shapes[0]?.fill).toBe('#800080');
    expect(l.shapes[1]?.fill).toBe('#00ff00');
    expect(l.shapes[1]?.opacity).toBe(0.5);
  });

  it('draws what a use points at, moved and transformed', () => {
    const l = logo(
      svg(
        '<defs><symbol id="dot" viewBox="0 0 2 2"><path d="M0 0h2v2H0z"/></symbol><path id="bar" d="M0 0h4v1H0z" fill="#336699"/></defs><use href="#dot" x="10" y="10" width="4" height="4" fill="#ff0000"/><use xlink:href="#bar" x="2" transform="translate(0 5)"/>',
      ),
    );
    expect(l.shapes).toHaveLength(2);
    expect(l.shapes[0]?.fill).toBe('#ff0000');
    expect(points(l.shapes[0]?.d ?? '')).toEqual(
      expect.arrayContaining([
        [10, 10],
        [14, 14],
      ]),
    );
    expect(points(l.shapes[1]?.d ?? '')).toEqual(
      expect.arrayContaining([
        [2, 5],
        [6, 6],
      ]),
    );
  });

  it('leaves out what is hidden and what only defines things', () => {
    const l = logo(
      svg(
        '<path d="M0 0h1v1H0z" fill="#ff0000" display="none"/><g style="display:none"><path d="M2 2h1v1H2z" fill="#00ff00"/></g><clipPath id="c"><path d="M5 5h1v1H5z" fill="#0000ff"/></clipPath><path d="M9 9h1v1H9z" fill="#abcdef" clip-path="url(#c)"/><path d="M3 3h1v1H3z" fill="#ff00ff" visibility="hidden"/><path d="M4 4h1v1H4z" fill="none"/>',
      ),
    );
    expect(l.shapes.map((s) => s.fill)).toEqual(['#abcdef']);
  });

  it('never lets anything of the file through', () => {
    const r = svgToLogo(
      svg(
        '<script>alert(1)</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject><a href="javascript:alert(1)"><path d="M0 0h10v10H0z" fill="#ff0000" onload="alert(1)" onclick="javascript:x()"/></a><path d="M12 12 javascript:alert(1) L 20 20" stroke="#0000ff"/><path d="M1 1h2v2z" fill="url(https://evil.example/x.svg#a) #00ff00"/>',
        'viewBox="0 0 24 24" onload="alert(1)"',
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(ThingLogo.parse(r.logo)).toEqual(r.logo);
    const json = JSON.stringify(r.logo).toLowerCase();
    for (const bad of ['script', 'javascript', '<', 'url(', 'alert', 'http', 'onload'])
      expect(json).not.toContain(bad);
    expect(r.logo.shapes.map((s) => s.fill)).toContain('#00ff00');
  });

  it('reads colours in every CSS form', () => {
    const l = logo(
      svg(
        [
          '<path d="M0 0h1v1H0z" fill="#f00"/>',
          '<path d="M2 0h1v1H2z" fill="rgba(0,0,255,0.5)"/>',
          '<path d="M4 0h1v1H4z" fill="hsl(120, 100%, 25%)"/>',
          '<path d="M6 0h1v1H6z" fill="rebeccapurple"/>',
          '<path d="M8 0h1v1H8z" fill="#00ff0080"/>',
          '<path d="M10 0h1v1H10z" fill="rgb(100% 0% 0% / 25%)"/>',
          '<path d="M12 0h1v1H12z" fill="transparent" stroke="currentColor"/>',
        ].join(''),
      ),
    );
    expect(l.shapes.map((s) => s.fill)).toEqual([
      '#ff0000',
      '#0000ff',
      '#008000',
      '#663399',
      '#00ff00',
      '#ff0000',
      'none',
    ]);
    expect(l.shapes[1]?.opacity).toBe(0.5);
    expect(l.shapes[4]?.opacity).toBeCloseTo(0.502, 3);
    expect(l.shapes[5]?.opacity).toBe(0.25);
    expect(l.shapes[6]?.stroke).toBe('currentColor');
  });

  it('merges shapes painted alike that don’t overlap, and keeps overlapping fills apart', () => {
    const l = logo(
      svg(
        '<g fill="#ff0000"><path d="M0 0h2v2H0z"/><path d="M4 0h2v2H4z"/><path d="M5 1h2v2H5z"/></g><path d="M10 10h1v1h-1z" fill="#00ff00"/>',
      ),
    );
    expect(l.shapes.map((s) => s.fill)).toEqual(['#ff0000', '#ff0000', '#00ff00']);
    expect(points(l.shapes[0]?.d ?? '')).toEqual(expect.arrayContaining([[4, 0]]));
  });

  it('turns a single near-white colour into the text colour, and keeps a mid colour', () => {
    expect(logo(svg('<path d="M0 0h1v1H0z" fill="#fefefe"/>')).shapes[0]?.fill).toBe('currentColor');
    expect(logo(svg('<path d="M0 0h1v1H0z" fill="#3366cc"/>')).shapes[0]?.fill).toBe('#3366cc');
  });

  it('takes the box from width and height when there is no viewBox', () => {
    expect(logo(svg('<path d="M0 0h1v1H0z"/>', 'width="48px" height="32"')).viewBox).toBe('0 0 48 32');
    expect(logo(svg('<path d="M0 0h1v1H0z"/>', 'viewBox="0,0,24.50,24.000"')).viewBox).toBe('0 0 24.5 24');
    expect(problem(svg('<path d="M0 0h1v1H0z"/>', 'width="100%"'))).toBe('invalid');
  });

  it('rounds coordinates to the size of the box', () => {
    const small = logo(svg('<path d="M1.234567 2.345678L3.456789 4.567891" stroke="#ff0000"/>'));
    expect(small.shapes[0]?.d).toContain('1.23');
    expect(small.shapes[0]?.d).not.toContain('1.234');
    const big = logo(svg('<path d="M1.234567 2.345678L300.456789 400.567891"/>', 'viewBox="0 0 1000 1000"'));
    expect(big.shapes[0]?.d).toMatch(/^M1 2/);
  });

  it('refuses what it can’t draw', () => {
    expect(problem(svg('<text x="0" y="10">Acme</text>'))).toBe('text');
    expect(problem(svg('<g><text><tspan>Acme</tspan></text></g>'))).toBe('text');
    expect(problem(svg('<image href="data:image/png;base64,AAAA" width="10" height="10"/>'))).toBe('picture');
    expect(
      problem(
        svg(
          '<mask id="m"><rect width="24" height="24" fill="#fff"/></mask><path d="M0 0h10v10H0z" mask="url(#m)"/>',
        ),
      ),
    ).toBe('mask');
    expect(problem(svg('<g style="mask:url(#m)"><path d="M0 0h10v10H0z"/></g>'))).toBe('mask');
  });

  it('draws text and pictures that are never shown', () => {
    expect(logo(svg('<defs><text id="t">Hi</text></defs><path d="M0 0h1v1H0z"/>')).shapes).toHaveLength(1);
    expect(logo(svg('<image href="x.png" display="none"/><path d="M0 0h1v1H0z"/>')).shapes).toHaveLength(1);
  });

  it('says when there is nothing to draw', () => {
    expect(problem(svg(''))).toBe('nothing');
    expect(problem(svg('<title>Empty</title><defs><path id="p" d="M0 0h1v1z"/></defs>'))).toBe('nothing');
  });

  it('refuses a file that is too large, too complex or not an SVG', () => {
    expect(problem(svg(`<!--${'x'.repeat(SVG_LOGO_BYTES_MAX)}-->`))).toBe('too_large');
    const many = Array.from(
      { length: 70 },
      (_, i) => `<path d="M${i} 0h1v1h-1z" fill="#${(i * 3 + 16).toString(16).padStart(2, '0')}0000"/>`,
    );
    expect(problem(svg(many.join(''), 'viewBox="0 0 100 10"'))).toBe('too_complex');
    expect(
      problem('<!DOCTYPE html><html><body><svg viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg></body></html>'),
    ).toBe('not_svg');
    expect(problem('just some text')).toBe('not_svg');
    expect(problem('')).toBe('not_svg');
  });

  it('stays quick on a long style sheet', () => {
    const rules = Array.from({ length: 5000 }, (_, i) => `.c${i}{fill:#ff0000}`).join('');
    const paths = Array.from(
      { length: 5000 },
      (_, i) => `<path class="c${i}" d="M${i % 90} 0h1v1h-1z"/>`,
    ).join('');
    const started = performance.now();
    const r = svgToLogo(svg(`<style>${rules}</style>${paths}`, 'viewBox="0 0 100 10"'));
    expect(performance.now() - started).toBeLessThan(4000);
    expect(r.ok || r.problem === 'too_complex').toBe(true);
  });

  it('never throws on broken input', () => {
    const broken = [
      '<svg viewBox="0 0 24 24"><path d="M0 0 L',
      '<svg viewBox="0 0 24 24"><path d="M0 0L5 5" transform="rotate(" stroke="#f00"/></svg>',
      '<svg viewBox="0 0 24 24"><g><g><use href="#a"/></g></g><g id="a"><use href="#a"/><path d="M0 0h1v1z"/></g></svg>',
      '<svg viewBox="0 0 24 24"><path d="M0 0h1v1z" fill="url(#missing)" stroke="#zzz"/></svg>',
      '<svg viewBox="0 0 24 24"><path d="M0 0h1v1z" transform="scale(0)"/></svg>',
      '<svg viewBox="NaN 0 Infinity 24" width="1e400" height="2"><path d="M0 0h1v1z"/></svg>',
      '<svg viewBox="0 0 24 24"><style>{{{}}}@import "x";.a{fill:</style><path class="a" d="M0 0h1v1z"/></svg>',
      '<svg viewBox="0 0 24 24"><style>.__proto__{fill:red}</style><path class="__proto__ constructor" fill="constructor" d="M0 0h1v1z"/></svg>',
      `<svg viewBox="0 0 24 24">${'<g>'.repeat(500)}<path d="M0 0h1v1z"/>${'</g>'.repeat(500)}</svg>`,
    ];
    for (const b of broken) {
      const r = svgToLogo(b);
      if (r.ok) expect(ThingLogo.parse(r.logo)).toEqual(r.logo);
      else expect(r.message).toBeTruthy();
    }
  });
});
