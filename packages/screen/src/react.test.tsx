import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_ASSISTANT,
  FIXTURE_BOX_GRID,
  FIXTURE_BOX_GRID_WRONG,
  FIXTURE_CALM,
  FIXTURE_CALM_WRONG,
  FIXTURE_NOW,
  FIXTURE_QUESTION,
  FIXTURE_TABLET_GRID,
  FIXTURE_TIME_ZONE,
  FIXTURE_VIEWS,
  FIXTURE_WEATHER_NEWS_VIEWS,
} from './fixtures';
import { Screen, type ScreenProps, WidgetPreview, WidgetView } from './react';
import type { DeskGrid, DeskWidget } from './types';

const draw = (grid: DeskGrid, more: Partial<ScreenProps> = {}) =>
  renderToStaticMarkup(
    <Screen
      width={1280}
      height={800}
      grid={grid}
      calm={grid.attention.items.length ? FIXTURE_CALM_WRONG : FIXTURE_CALM}
      name="Home"
      assistant={FIXTURE_ASSISTANT}
      timeZone={FIXTURE_TIME_ZONE}
      now={FIXTURE_NOW}
      {...more}
    />,
  );

const widget = (id: string, type: DeskWidget['type'], w: number, h: number) =>
  renderToStaticMarkup(
    <WidgetView
      widget={{ id, type, opts: {} }}
      view={[...FIXTURE_VIEWS, ...FIXTURE_WEATHER_NEWS_VIEWS].find((v) => v.id === id)}
      calm={FIXTURE_CALM}
      w={w}
      h={h}
      pw={w * 144 + (w - 1) * 12}
      ph={h * 135 + (h - 1) * 12}
      now={FIXTURE_NOW}
    />,
  );

describe('<Screen>', () => {
  it('draws the top bar, the pages and the first page’s widgets', () => {
    const html = draw(FIXTURE_BOX_GRID);
    expect(html).toContain('data-theme="dark"');
    for (const name of ['Home', 'Overview', 'Media', 'House', '14:34', 'Tuesday 27 October', 'All fine'])
      expect(html).toContain(name);
    for (const id of ['w_clock', 'w_status', 'w_climate', 'w_now', 'w_pve01', 'w_internet', 'w_strip'])
      expect(html).toContain(`data-widget="${id}"`);
    expect(html).not.toContain('data-widget="w_playing"');
    expect(html).not.toContain('role="dialog"');
  });

  it('draws the page the host chooses', () => {
    const html = draw(FIXTURE_BOX_GRID, { page: 1 });
    expect(html).toContain('data-widget="w_playing"');
    expect(html).toContain('Dune: Part Two');
  });

  it('opens the modal for an outage, with the edge and “1 of 2”, the pill waiting until it’s put away', () => {
    const html = draw(FIXTURE_BOX_GRID_WRONG, { onFix: () => {}, onOpen: () => {} });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('pve-02 isn’t answering');
    expect(html).not.toContain('2 things need you');
    expect(html).toContain('1 of 2');
    expect(html).toContain('Ask Dusty to fix it');
    expect(html).toContain('Open pve-02');
    expect(html).toContain('Not now');
  });

  it('keeps what was put away closed, the pill still there', () => {
    const away = FIXTURE_BOX_GRID_WRONG.attention.items.map((i) => i.key);
    const html = draw(FIXTURE_BOX_GRID_WRONG, { away });
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain('2 things need you');
  });

  it('says to answer elsewhere on a screen elsewhere, and offers no step', () => {
    const grid = {
      ...FIXTURE_BOX_GRID_WRONG,
      attention: { items: [FIXTURE_QUESTION], more: 0 },
    };
    const html = draw(grid, { answerElsewhere: true, onAnswer: () => {} });
    expect(html).toContain('on your phone');
    expect(html).not.toContain('>Answer<');
  });

  it('draws a question with its own words and answers when the host knows them', () => {
    const grid = { ...FIXTURE_BOX_GRID_WRONG, attention: { items: [FIXTURE_QUESTION], more: 0 } };
    let pressed = '';
    const html = draw(grid, {
      onAnswer: () => {},
      askView: () => ({
        quote: 'Hi Marieke, the order form works again.',
        facts: ['mail · bakkerij@example.nl'],
        from: 'Banjo',
        buttons: [
          { key: 'approve', label: 'Send it', primary: true, onPress: () => (pressed = 'approve') },
          { key: 'agent', label: 'Always allow Banjo to send mail', lock: true, onPress: () => {} },
          { key: 'deny', label: 'Don’t send it', onPress: () => {} },
        ],
        note: { text: 'Your PIN first, then it sends.', icon: 'lock' },
      }),
    });
    for (const words of [
      'Hi Marieke, the order form works again.',
      'mail · bakkerij@example.nl',
      'Banjo asks',
    ])
      expect(html).toContain(words);
    for (const label of [
      'Send it',
      'Always allow Banjo to send mail',
      'Don’t send it',
      'Not now',
      'Your PIN first',
    ])
      expect(html).toContain(label);
    expect(html).not.toContain('>Answer<');
    expect(pressed).toBe('');
  });

  it('lets an answer on its way hold the buttons, and keeps a screen elsewhere from answering', () => {
    const grid = { ...FIXTURE_BOX_GRID_WRONG, attention: { items: [FIXTURE_QUESTION], more: 0 } };
    const view = () => ({
      buttons: [{ key: 'approve', label: 'Send it', primary: true, onPress: () => {} }],
      busy: true,
    });
    expect(draw(grid, { askView: view })).toContain('aria-disabled="true"');
    const elsewhere = draw(grid, { askView: view, answerElsewhere: true });
    expect(elsewhere).not.toContain('Send it');
    expect(elsewhere).toContain('on your phone');
  });

  it('draws pages as dots on a narrow screen', () => {
    const html = renderToStaticMarkup(
      <Screen
        width={820}
        height={1180}
        grid={FIXTURE_TABLET_GRID}
        name="Home"
        assistant="Dusty"
        now={FIXTURE_NOW}
      />,
    );
    expect(html).toContain('aria-label="Kitchen, page 1 of 2"');
  });

  it('draws the cells and no modal while editing', () => {
    const html = draw(FIXTURE_BOX_GRID_WRONG, { editing: true });
    expect(html).not.toContain('role="dialog"');
    expect(html.match(/data-widget=/g)?.length).toBe(7);
  });

  it('shows only the time when the lock says so', () => {
    const html = draw(FIXTURE_BOX_GRID, { onlyTime: true });
    expect(html).toContain('14:34');
    expect(html).not.toContain('data-widget=');
  });

  it('says the draft is being tried', () => {
    const until = new Date(FIXTURE_NOW + 42_000).toISOString();
    expect(draw({ ...FIXTURE_BOX_GRID, trying: { until } })).toContain('42 s');
  });
});

describe('<WidgetView>', () => {
  it('draws now playing as a count, a list, posters', () => {
    expect(widget('w_playing', 'panel', 2, 1)).toContain('2 watching');
    expect(widget('w_playing', 'panel', 2, 2)).toContain('Sanne · iPad');
    expect(widget('w_playing', 'panel', 4, 2)).toContain('1:42 of 2:46');
  });

  it('draws a server’s figure, meters and chart', () => {
    expect(widget('w_pve01', 'server', 2, 1)).toContain('processor');
    expect(widget('w_pve01', 'server', 2, 2)).toContain('Memory');
    expect(widget('w_pve01', 'server', 4, 2)).toContain('Processor · 24 h');
  });

  it('draws a problem in its place, a locked view as locked', () => {
    const v = FIXTURE_VIEWS.find((x) => x.id === 'w_queue') ?? FIXTURE_VIEWS[0];
    if (!v) throw new Error('no queue');
    const bad = renderToStaticMarkup(
      <WidgetView
        widget={{ id: v.id, type: 'panel', opts: {} }}
        view={{ ...v, problem: { text: 'Stopped', detail: 'It runs on pve-02, which is down.' } }}
        w={4}
        h={2}
        pw={600}
        ph={280}
      />,
    );
    expect(bad).toContain('data-tone="bad"');
    expect(bad).toContain('Stopped');
    const locked = renderToStaticMarkup(
      <WidgetView
        widget={{ id: v.id, type: 'panel', opts: {} }}
        view={{ ...v, locked: true }}
        w={4}
        h={2}
        pw={600}
        ph={280}
      />,
    );
    expect(locked).toContain('Unlock to see it');
    expect(locked).not.toContain('Shōgun');
  });

  it('keeps Whombat’s own sign over a locked Done today', () => {
    const v = FIXTURE_VIEWS.find((x) => x.id === 'w_done');
    if (v?.kind !== 'list') throw new Error('no done');
    const html = renderToStaticMarkup(
      <WidgetView
        widget={{ id: v.id, type: 'done', opts: {} }}
        view={{ ...v, rows: [], locked: true }}
        w={2}
        h={2}
        pw={300}
        ph={280}
      />,
    );
    expect(html).toContain('Unlock to see it');
    expect(html).toContain('Done today');
    expect(html).not.toContain('Renewed');
  });

  it('draws the weather from the temperature alone up to the hours and the days, with MET’s credit where there’s room', () => {
    const tile = widget('w_weather', 'weather', 1, 1);
    expect(tile).toContain('11°');
    expect(tile).not.toContain('Partly cloudy');
    expect(tile).not.toContain('MET Norway');
    expect(widget('w_weather', 'weather', 2, 1)).toContain('Partly cloudy');
    const strip = widget('w_weather', 'weather', 4, 1);
    expect(strip).toContain('Now');
    expect(strip).not.toContain('MET Norway');
    const block = widget('w_weather', 'weather', 2, 2);
    expect(block).toContain('Amsterdam');
    expect(block).toContain('Data from MET Norway');
    expect(block).not.toContain('Today');
    const large = widget('w_weather', 'weather', 4, 3);
    expect(large).toContain('Today');
    expect(large).toContain('Wed');
    // The test draws without the Whombat's time zone, so only that the times are there.
    expect(large).toMatch(/Sunrise \d\d:\d\d · Sunset \d\d:\d\d/);
    expect(large).toContain('Data from MET Norway');
  });

  it('says the weather couldn’t be read as every problem, and how to choose the news', () => {
    const bad = widget('w_weather_wrong', 'weather', 2, 2);
    expect(bad).toContain('data-tone="bad"');
    expect(bad).toContain('Can’t read the weather');
    expect(widget('w_news_none', 'news', 3, 2)).toContain('Choose your news in Settings');
    const news = widget('w_news', 'news', 3, 2);
    expect(news).toContain('New cycle bridge');
    expect(news).toContain('AT5 · 13:40');
  });

  it('draws the calm glance’s servers with the rest counted', () => {
    const html = widget('w_strip', 'strip', 6, 1);
    expect(html).toContain('pve-01');
    expect(html).toContain('+3');
  });
});

describe('<WidgetPreview>', () => {
  it('draws one widget alone, scaled, with nothing to touch', () => {
    const view = FIXTURE_VIEWS.find((v) => v.id === 'w_pve01');
    const html = renderToStaticMarkup(
      <WidgetPreview
        widget={{ id: 'w_pve01', type: 'server', opts: {} }}
        view={view}
        w={2}
        h={2}
        width={300}
        assistant="Dusty"
      />,
    );
    expect(html).toContain('pve-01');
    expect(html).toContain('data-theme="dark"');
    expect(html).not.toContain('<button');
  });
});
