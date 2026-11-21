import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WhombatLogo } from './react.js';

describe('<WhombatLogo>', () => {
  it('is an image with a label, decorative without one', () => {
    const labelled = renderToStaticMarkup(<WhombatLogo variant="lockup" height={24} label="Whombat" />);
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain('aria-label="Whombat"');
    expect(labelled).not.toContain('aria-hidden');
    expect(labelled).toContain('data-logo="lockup"');
    const decorative = renderToStaticMarkup(<WhombatLogo height={16} />);
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).not.toContain('role="img"');
  });
});
