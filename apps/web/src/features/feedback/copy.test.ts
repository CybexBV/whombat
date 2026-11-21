import { describe, expect, it } from 'vitest';
import { snippetForTrail, trailBefore, trailPath } from './copy';

describe('pages before reporting (CT-161)', () => {
  it('shows the path and how long before sending', () => {
    expect(trailPath('https://billing.example.com/invoices/:id')).toBe('/invoices/:id');
    expect(trailPath('not a url')).toBe('not a url');
    const sent = '2026-09-30T10:47:00.000Z';
    expect(trailBefore('2026-09-30T10:39:00.000Z', sent)).toBe('8 min before');
    expect(trailBefore('2026-09-30T10:46:30.000Z', sent)).toBe('under a minute before');
    expect(trailBefore('2026-09-30T10:48:00.000Z', sent)).toBe('under a minute before');
    expect(trailBefore('2026-09-30T09:42:00.000Z', sent)).toBe('1 h 5 min before');
    expect(trailBefore('2026-09-30T08:47:00.000Z', sent)).toBe('2 h before');
    expect(trailBefore('2026-09-30T10:39:00.000Z', null)).toBeNull();
    expect(trailBefore('nope', sent)).toBeNull();
  });
});

describe('the snippet with pages visited off (AP-435)', () => {
  const basic =
    '<script\n  src="https://w.example/embed/v1/widget.js"\n  data-site="fbs_x"\n  defer\n></script>';

  it('adds data-trail="off" before defer, once', () => {
    const off = snippetForTrail(basic, 'off');
    expect(off).toBe(
      '<script\n  src="https://w.example/embed/v1/widget.js"\n  data-site="fbs_x"\n  data-trail="off"\n  defer\n></script>',
    );
    expect(snippetForTrail(off, 'off')).toBe(off);
    expect(snippetForTrail(basic, 'on')).toBe(basic);
  });
});
