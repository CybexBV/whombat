/**
 * The page `shots.ts` photographs: one screen (or the sizes sheet) from the fixtures, chosen by the address's hash.
 * Bundled with esbuild, no Vite; the tokens' CSS and the web app's fonts are linked by the page.
 */
import { type ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  FIXTURE_ASSISTANT,
  FIXTURE_BOX_GRID,
  FIXTURE_BOX_GRID_WRONG,
  FIXTURE_BOX_LAYOUT,
  FIXTURE_CALM,
  FIXTURE_CALM_WRONG,
  FIXTURE_DOORBELL_GRID,
  FIXTURE_DOORBELL_GRID_LOCKED,
  FIXTURE_KINDS_GRID,
  FIXTURE_MONITOR_GRID,
  FIXTURE_NAME,
  FIXTURE_NOW,
  FIXTURE_PHOTO_BOARD_VIEWS,
  FIXTURE_SERVER_VIEWS,
  FIXTURE_TABLET_GRID,
  FIXTURE_TIME_ZONE,
  FIXTURE_VIEWS,
  FIXTURE_WEATHER_NEWS_VIEWS,
  fixtureLoadImage,
} from '../src/fixtures';
import { cellRect, screenGrid } from '../src/grid';
import { ChipIcon, EnvProvider, Screen, ScreenChip, type ScreenProps, WidgetView } from '../src/react';
import type { DeskGrid, DeskLayout, DeskWidget } from '../src/types';

const boxChips = (locked: boolean) => (
  <>
    <ScreenChip icon={<ChipIcon name="wifi" />}>Ziggo-5G</ScreenChip>
    <ScreenChip icon={<ChipIcon name="online" />}>Online</ScreenChip>
    <ScreenChip icon={<ChipIcon name="battery" percent={84} />}>84&nbsp;%</ScreenChip>
    <ScreenChip icon={<ChipIcon name="lock" />}>{locked ? 'Locked' : 'Unlocked'}</ScreenChip>
  </>
);
const elsewhereChips = (locked: boolean) => (
  <>
    <ScreenChip icon={<ChipIcon name="online" />}>Online</ScreenChip>
    <ScreenChip icon={<ChipIcon name="lock" />}>{locked ? 'Locked' : 'Unlocked'}</ScreenChip>
  </>
);

const DEFAULT_LAYOUT: DeskLayout = {
  pages: [
    {
      id: 'p_first',
      name: 'Overview',
      layouts: {
        '8x5': [
          { id: 'w_clock', type: 'clock', opts: {}, x: 0, y: 0, w: 4, h: 2 },
          { id: 'w_status', type: 'status', opts: {}, x: 4, y: 0, w: 4, h: 2 },
          { id: 'w_now', type: 'now', opts: {}, x: 0, y: 2, w: 8, h: 2 },
          { id: 'w_strip', type: 'strip', opts: {}, x: 0, y: 4, w: 8, h: 1 },
        ],
      },
      last: '8x5',
    },
  ],
  turn: 'touch',
  size: 'normal',
};

const base = {
  name: FIXTURE_NAME,
  assistant: FIXTURE_ASSISTANT,
  timeZone: FIXTURE_TIME_ZONE,
  now: FIXTURE_NOW,
  loadImage: fixtureLoadImage,
  onServer: () => {},
  onServers: () => {},
  onDoneToday: () => {},
  onAnswer: () => {},
  onFix: () => {},
  onStep: () => {},
  onOpen: () => {},
};

function box(grid: DeskGrid, extra: Partial<ScreenProps> = {}, size = { width: 1280, height: 800 }) {
  return (
    <Screen
      {...base}
      {...size}
      grid={grid}
      calm={grid.attention.items.length ? FIXTURE_CALM_WRONG : FIXTURE_CALM}
      chips={boxChips(true)}
      {...extra}
    />
  );
}

/** The mockups' `f-sizes`: one widget at several sizes. */
function Sizes() {
  const g = screenGrid(1280, 800);
  const rows: [string, string, string, DeskWidget['type'], [number, number][]][] = [
    [
      'w_playing',
      'Plex · Now playing',
      'a count, a list, posters',
      'panel',
      [
        [2, 1],
        [2, 2],
        [4, 2],
      ],
    ],
    [
      'w_pve01',
      'A server',
      'a figure, three bars, a chart',
      'server',
      [
        [2, 1],
        [2, 2],
        [4, 2],
      ],
    ],
    [
      'w_climate',
      'A sensor',
      'a figure, its day',
      'panel',
      [
        [1, 1],
        [2, 1],
        [2, 2],
      ],
    ],
    [
      'w_queue',
      'Download queue',
      'one line, the queue',
      'panel',
      [
        [2, 1],
        [4, 2],
      ],
    ],
  ];
  return (
    <EnvProvider
      value={{
        assistant: FIXTURE_ASSISTANT,
        timeZone: FIXTURE_TIME_ZONE,
        loadImage: fixtureLoadImage,
        editing: false,
      }}
    >
      <div className="sheet">
        <h2>One widget, several sizes</h2>
        {rows.map(([id, name, sub, type, sizes]) => (
          <div key={id} className="srow">
            <div className="tl">
              {name}
              <span>{sub}</span>
            </div>
            {sizes.map(([w, h]) => {
              const r = cellRect(g, { x: 0, y: 0, w, h });
              return (
                <div key={`${w}x${h}`} className="smp">
                  <div className="sz">
                    {w} × {h}
                  </div>
                  <div style={{ position: 'relative', width: r.width, height: r.height }}>
                    <WidgetView
                      widget={{ id, type, opts: {} }}
                      view={FIXTURE_VIEWS.find((v) => v.id === id)}
                      w={w}
                      h={h}
                      pw={r.width}
                      ph={r.height}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </EnvProvider>
  );
}

/** `f-servers`: a server's widgets (DK-152, DK-153) — the overview at its sizes with its blocks, then each part. */
function Servers() {
  const g = screenGrid(1280, 800);
  const views = [...FIXTURE_VIEWS, ...FIXTURE_SERVER_VIEWS];
  const rows: [string, string, [string, string, number, number][]][] = [
    [
      'Overview',
      'its figure, its card, its meters, its chart',
      [
        ['w_pve01', '', 2, 1],
        ['w_pve01', '', 3, 1],
        ['w_pve01', '', 2, 2],
        ['w_pve01', '', 4, 2],
      ],
    ],
    [
      'Short of disk',
      'amber blocks and why',
      [
        ['w_nas', '', 3, 1],
        ['w_nas', '', 2, 2],
      ],
    ],
    [
      'Charts',
      'processor, memory, network',
      [
        ['w_pve01_cpu', 'cpu', 4, 2],
        ['w_pve01_memory', 'memory', 2, 2],
        ['w_pve01_network', 'network', 2, 1],
      ],
    ],
    [
      'Lists',
      'storage, guests, alerts',
      [
        ['w_pve01_storage', 'storage', 3, 2],
        ['w_pve01_guests', 'guests', 3, 2],
        ['w_pve01_alerts', 'alerts', 3, 1],
      ],
    ],
    [
      'Temperature',
      'its hottest sensors',
      [
        ['w_pve01_temp', 'temp', 2, 1],
        ['w_pve01_temp', 'temp', 2, 2],
      ],
    ],
  ];
  return (
    <EnvProvider
      value={{
        assistant: FIXTURE_ASSISTANT,
        timeZone: FIXTURE_TIME_ZONE,
        loadImage: fixtureLoadImage,
        editing: false,
      }}
    >
      <div className="sheet">
        <h2>A server’s widgets</h2>
        {rows.map(([name, sub, shots]) => (
          <div key={name} className="srow">
            <div className="tl">
              {name}
              <span>{sub}</span>
            </div>
            {shots.map(([id, show, w, h]) => {
              const r = cellRect(g, { x: 0, y: 0, w, h });
              return (
                <div key={`${id}-${w}x${h}`} className="smp">
                  <div className="sz">
                    {w} × {h}
                  </div>
                  <div style={{ position: 'relative', width: r.width, height: r.height }}>
                    <WidgetView
                      widget={{ id, type: 'server', ref: 'server:pve-01', opts: show ? { show } : {} }}
                      view={views.find((v) => v.id === id)}
                      w={w}
                      h={h}
                      pw={r.width}
                      ph={r.height}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </EnvProvider>
  );
}

/** `f-photo-board`: the photo and board views (DK-160, DK-162) at their sizes, empty and locked. */
function PhotoBoard() {
  const g = screenGrid(1280, 800);
  const view = (id: string, locked?: boolean) => {
    const v = FIXTURE_PHOTO_BOARD_VIEWS.find((x) => x.id === id);
    return v && locked ? { ...v, locked: true } : v;
  };
  const rows: [string, string, [string, number, number, boolean?][]][] = [
    [
      'Boards, small',
      'a strip of tiles, the rest counted',
      [
        ['w_containers', 2, 1],
        ['w_containers_all', 3, 1],
        ['w_repos', 3, 1],
        ['w_devices', 4, 1],
      ],
    ],
    [
      'Boards, middle',
      'values beside or under',
      [
        ['w_devices', 2, 2],
        ['w_containers', 4, 2],
        ['w_repos', 2, 2],
      ],
    ],
    ['Board, big', '40 containers', [['w_containers', 8, 4]]],
    ['Board, all', '40 of 52, a long head', [['w_containers_all', 8, 3]]],
    [
      'Empty and locked',
      'as lists do',
      [
        ['w_devices_none', 2, 1],
        ['w_devices_none', 3, 2],
        ['w_containers', 2, 1, true],
        ['w_memories_none', 2, 2],
        ['w_memories', 2, 2, true],
      ],
    ],
    [
      'Photos',
      'one picture, its words',
      [
        ['w_memories', 2, 2],
        ['w_memories', 4, 3],
        ['w_frame', 3, 2],
      ],
    ],
    ['Photo, big', 'the whole screen', [['w_memories', 8, 5]]],
  ];
  return (
    <EnvProvider
      value={{
        assistant: FIXTURE_ASSISTANT,
        timeZone: FIXTURE_TIME_ZONE,
        loadImage: fixtureLoadImage,
        editing: false,
      }}
    >
      <div className="sheet">
        <h2>Photos and boards</h2>
        {rows.map(([name, sub, shots]) => (
          <div key={name} className="srow" style={{ flexWrap: 'wrap' }}>
            <div className="tl">
              {name}
              <span>{sub}</span>
            </div>
            {shots.map(([id, w, h, isLocked]) => {
              const r = cellRect(g, { x: 0, y: 0, w, h });
              const v = view(id, isLocked);
              return (
                <div key={`${id}-${w}x${h}-${isLocked ?? ''}`} className="smp">
                  <div className="sz">
                    {w} × {h}
                    {isLocked ? ' · locked' : ''}
                  </div>
                  <div style={{ position: 'relative', width: r.width, height: r.height }}>
                    <WidgetView
                      widget={{ id, type: 'panel', ref: 'connection:con_x', opts: {} }}
                      view={v}
                      w={w}
                      h={h}
                      pw={r.width}
                      ph={r.height}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </EnvProvider>
  );
}

const locked = (grid: DeskGrid): DeskGrid => ({
  ...grid,
  views: grid.views.map((v) => (v.id === 'w_door' || v.id === 'w_today' ? { ...v, locked: true } : v)),
});

export const SHOTS: Record<string, () => ReactNode> = {
  'f-default': () => box({ ...FIXTURE_BOX_GRID, layout: DEFAULT_LAYOUT }),
  'f-overview': () => box(FIXTURE_BOX_GRID, { page: 0 }),
  'f-media': () => box(FIXTURE_BOX_GRID, { page: 1 }),
  'f-house': () => box(FIXTURE_BOX_GRID, { page: 2, chips: boxChips(false) }),
  'f-problem': () => box(FIXTURE_BOX_GRID_WRONG, { page: 0 }),
  'f-ask': () => box(FIXTURE_BOX_GRID_WRONG, { page: 0, locked: true }),
  'f-notnow': () => box(FIXTURE_BOX_GRID_WRONG, { page: 0 }),
  // The question with its own words and answers, as the box's console gives them (DK-151).
  'f-ask-own': () =>
    box(FIXTURE_BOX_GRID_WRONG, {
      page: 0,
      askView: () => ({
        quote:
          '“Hi Marieke, the order form works again. Your three orders from this morning came through fine.”',
        facts: ['Mail · marieke@bakkerijdevries.example'],
        buttons: [
          { key: 'approve', label: 'Send it', primary: true, onPress: () => {} },
          { key: 'agent', label: 'Always allow Dusty to send replies', lock: true, onPress: () => {} },
          { key: 'deny', label: 'Don’t send it', onPress: () => {} },
        ],
      }),
    }),
  'f-monitor': () =>
    box(FIXTURE_MONITOR_GRID, { chips: elsewhereChips(true) }, { width: 1920, height: 1080 }),
  'f-tablet': () => box(FIXTURE_TABLET_GRID, { chips: elsewhereChips(false) }, { width: 820, height: 1180 }),
  'f-elsewhere-ask': () =>
    box(
      { ...FIXTURE_TABLET_GRID, attention: FIXTURE_BOX_GRID_WRONG.attention },
      {
        chips: elsewhereChips(true),
        answerElsewhere: true,
        onAnswer: undefined,
        onFix: undefined,
        onStep: undefined,
      },
      { width: 820, height: 1180 },
    ),
  'f-big': () => box(FIXTURE_BOX_GRID, { page: 1 }),
  'f-locked': () => box(locked(FIXTURE_BOX_GRID), { page: 2 }),
  'f-editing': () => box(FIXTURE_BOX_GRID, { page: 0, editing: true }),
  'f-larger': () =>
    box({ ...FIXTURE_BOX_GRID, layout: { ...FIXTURE_BOX_LAYOUT, size: 'larger' } }, { page: 0 }),
  'f-trying': () =>
    box(
      { ...FIXTURE_BOX_GRID, trying: { until: new Date(FIXTURE_NOW + 42_000).toISOString() } },
      { page: 1 },
    ),
  'f-kinds': () => box(FIXTURE_KINDS_GRID),
  /** The doorbell rang: its camera big for a minute, 40 seconds left; and the same on a locked screen. */
  'f-doorbell': () => box(FIXTURE_DOORBELL_GRID),
  'f-doorbell-locked': () => box(FIXTURE_DOORBELL_GRID_LOCKED),
  /** The console's widest top bar: the pages move out of the chips' way. */
  'f-wide-chips': () =>
    box(FIXTURE_BOX_GRID_WRONG, {
      away: FIXTURE_BOX_GRID_WRONG.attention.items.map((i) => i.key),
      chips: (
        <>
          <ScreenChip>Talk to Dusty</ScreenChip>
          <ScreenChip icon={<ChipIcon name="wifi" />}>Ziggo-5G-Upstairs</ScreenChip>
          <ScreenChip>Support is connected</ScreenChip>
          <ScreenChip>Getting an update</ScreenChip>
          <ScreenChip icon={<ChipIcon name="battery" percent={84} />}>84&nbsp;%</ScreenChip>
          <ScreenChip icon={<ChipIcon name="lock" />}>Locked</ScreenChip>
        </>
      ),
    }),
  'f-sizes': () => <Sizes />,
  'f-servers': () => <Servers />,
  'f-photo-board': () => <PhotoBoard />,
  'f-weather-news': () => <WeatherNews />,
};

/** `f-weather-news`: the weather (Whombat weather-news.md) in every form, at night, not read; the news, and with none on. */
function WeatherNews() {
  const g = screenGrid(1280, 800);
  const rows: [string, string, [string, 'weather' | 'news', number, number][]][] = [
    [
      'Weather, small',
      'the sign and the temperature, then the words',
      [
        ['w_weather', 'weather', 1, 1],
        ['w_weather', 'weather', 2, 1],
        ['w_weather', 'weather', 3, 1],
        ['w_weather_night', 'weather', 1, 1],
        ['w_weather_night', 'weather', 2, 1],
      ],
    ],
    ['Weather, a strip', 'the next hours beside it', [['w_weather', 'weather', 6, 1]]],
    [
      'Weather, middle',
      'the next hours under it',
      [
        ['w_weather', 'weather', 2, 2],
        ['w_weather', 'weather', 3, 2],
        ['w_weather', 'weather', 2, 3],
        ['w_weather_night', 'weather', 2, 2],
      ],
    ],
    [
      'Weather, wide',
      'the hours beside, the days under',
      [
        ['w_weather', 'weather', 4, 2],
        ['w_weather', 'weather', 4, 3],
      ],
    ],
    ['Weather, big', 'opened', [['w_weather', 'weather', 8, 4]]],
    [
      'Not read',
      'as every problem',
      [
        ['w_weather_wrong', 'weather', 1, 1],
        ['w_weather_wrong', 'weather', 2, 2],
      ],
    ],
    [
      'News',
      'headlines, none on',
      [
        ['w_news', 'news', 2, 1],
        ['w_news', 'news', 3, 2],
        ['w_news', 'news', 4, 3],
        ['w_news_none', 'news', 3, 2],
      ],
    ],
  ];
  return (
    <EnvProvider value={{ assistant: FIXTURE_ASSISTANT, timeZone: FIXTURE_TIME_ZONE, editing: false }}>
      <div className="sheet">
        <h2>Weather and news</h2>
        {rows.map(([name, sub, shots]) => (
          <div key={name} className="srow" style={{ flexWrap: 'wrap' }}>
            <div className="tl">
              {name}
              <span>{sub}</span>
            </div>
            {shots.map(([id, type, w, h]) => {
              const r = cellRect(g, { x: 0, y: 0, w, h });
              return (
                <div key={`${id}-${w}x${h}`} className="smp">
                  <div className="sz">
                    {w} × {h}
                  </div>
                  <div style={{ position: 'relative', width: r.width, height: r.height }}>
                    <WidgetView
                      widget={{ id, type, opts: {} }}
                      view={FIXTURE_WEATHER_NEWS_VIEWS.find((v) => v.id === id)}
                      w={w}
                      h={h}
                      pw={r.width}
                      ph={r.height}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </EnvProvider>
  );
}

const name = decodeURIComponent(location.hash.slice(1)) || 'f-overview';
const root = document.getElementById('root');
const draw = SHOTS[name];
if (root && draw)
  createRoot(root).render(
    <StrictMode>
      <div data-theme="dark">{draw()}</div>
    </StrictMode>,
  );
