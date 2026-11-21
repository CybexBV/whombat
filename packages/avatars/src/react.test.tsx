import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HumanAvatar, WhombatAvatar } from './react';
import { AVATAR_URLS } from './urls';

describe('<WhombatAvatar>', () => {
  it('is one static image with explicit size, lazy and async, not draggable', () => {
    const html = renderToStaticMarkup(<WhombatAvatar face="skipper" size={64} label="Skipper" />);
    expect(html).toMatch(/^<img /);
    expect(html).toContain(`src="${AVATAR_URLS.skipper.bust}"`);
    expect(html).toContain('alt="Skipper"');
    expect(html).toContain('width="64"');
    expect(html).toContain('height="64"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('draggable="false"');
    expect(html).not.toMatch(/border-radius|background|<svg/);
  });

  it('is decorative without a label or when asked, and loads eagerly above the fold', () => {
    expect(renderToStaticMarkup(<WhombatAvatar face="skipper" />)).toContain('alt=""');
    expect(renderToStaticMarkup(<WhombatAvatar face="skipper" label="Skipper" decorative />)).toContain(
      'alt=""',
    );
    expect(renderToStaticMarkup(<WhombatAvatar face="skipper" size={160} eager />)).toContain(
      'loading="eager"',
    );
  });

  it('defaults to 40px and picks the file from the size', () => {
    expect(renderToStaticMarkup(<WhombatAvatar face="hazel" />)).toContain(AVATAR_URLS.hazel.bust);
    expect(renderToStaticMarkup(<WhombatAvatar face="neo" size={32} />)).toContain(AVATAR_URLS.neo.head);
    expect(renderToStaticMarkup(<WhombatAvatar face="neo" size={24} crop="bust" />)).toContain(
      AVATAR_URLS.neo['head-small'],
    );
    expect(renderToStaticMarkup(<WhombatAvatar face="dusty" size={48} />)).toContain('data-avatar="dusty"');
  });

  it('is an empty box of the same size while loading, with no request', () => {
    const html = renderToStaticMarkup(<WhombatAvatar face="skipper" size={32} silhouette />);
    expect(html).not.toContain('<img');
    expect(html).toContain('width:32px');
    expect(html).toContain('aria-hidden="true"');
  });
});

describe('<HumanAvatar>', () => {
  it('shows two initials on a tone, labelled when asked', () => {
    const html = renderToStaticMarkup(<HumanAvatar initials="mara okafor" size={28} label="Mara Okafor" />);
    expect(html).toContain('>MA<');
    expect(html).toContain('aria-label="Mara Okafor"');
  });
});

describe('<HumanAvatar> with a photo', () => {
  it('draws the photo round over the initials, which stay underneath while it loads', () => {
    const html = renderToStaticMarkup(
      <HumanAvatar initials="MO" size={32} label="Mara Okafor" src="/api/v1/burrows/hq/attachments/att_1" />,
    );
    expect(html).toContain('aria-label="Mara Okafor"');
    expect(html).toContain('>MO<');
    expect(html).toMatch(/<img src="\/api\/v1\/burrows\/hq\/attachments\/att_1" alt=""/);
    expect(html).toContain('object-fit:cover');
    expect(html).toContain('border-radius:50%');
    expect(html).toContain('data-photo=""');
  });

  it('is the initials alone without a photo', () => {
    const html = renderToStaticMarkup(<HumanAvatar initials="MO" size={32} src={null} />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('data-photo');
  });
});
