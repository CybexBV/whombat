// Screens wall (PRODUCT-SPEC C8, SCREENS 3.7): a grid of 16:10 live
// thumbnails with name, status dot and type; clicking a tile opens its
// console. Stopped guests show a "powered off" tile, guests without a
// graphical screen (containers, `no_screen`) a terminal placeholder, and a
// missing console permission a placeholder with the reason.

import { useRef } from 'react';
import type { Guest } from '../../api/types';
import { Dot } from '../../components/controls';
import { Icon } from '../../components/Icon';
import { t, tx } from '../../lib/i18n';
import type { ScreensWallProps } from './types';
import { type ThumbState, useInViewport, usePageVisible, useThumbnail } from './useThumbnail';
import { guestStateInfo } from '../guests/guestActions';

function TileBody({ guest, thumb, blockedReason }: { guest: Guest; thumb: ThumbState; blockedReason: string | null }) {
  if (guest.state === 'stopped' || thumb.kind === 'stopped') {
    return (
      <div className="tile-msg">
        <Icon name="power" />
        <div className="tile-msg-text">
          {tx('{name} is powered off', { name: <span className="mono">{guest.name}</span> })}
        </div>
      </div>
    );
  }
  if (blockedReason || thumb.kind === 'denied') {
    return (
      <div className="tile-msg">
        <Icon name="shield" />
        <div className="tile-msg-text">{blockedReason ?? (thumb.kind === 'denied' ? thumb.reason : '')}</div>
      </div>
    );
  }
  if (thumb.kind === 'no_screen') {
    return (
      <div className="tile-msg">
        <Icon name="terminal" />
        <div className="tile-msg-text">{guest.kind === 'container' ? t('Text console · open the shell') : t('No graphical screen · open the console')}</div>
      </div>
    );
  }
  if (thumb.kind === 'image') {
    return (
      <>
        <img src={thumb.url} alt="" draggable={false} />
        {thumb.stale && <span className="tile-stale">{t('Not updating')}</span>}
      </>
    );
  }
  if (thumb.kind === 'error') {
    return (
      <div className="tile-msg">
        <Icon name="monitor" />
        <div className="tile-msg-text">{t('Preview unavailable')}</div>
      </div>
    );
  }
  return null; // loading: the empty screen
}

function Tile({ serverId, guest, blockedReason, pageVisible, onOpen }: { serverId: string; guest: Guest; blockedReason: string | null; pageVisible: boolean; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const inView = useInViewport(ref);
  const running = guest.state !== 'stopped';
  const thumb = useThumbnail({ serverId, guestId: guest.id, enabled: running && !blockedReason, visible: inView && pageVisible });
  const kind = guest.kind === 'vm' ? 'VM' : t('Container');
  const stateText = running ? guestStateInfo(guest.state).label.toLowerCase() : t('powered off');
  return (
    <li className="tile-item">
      <button
        ref={ref}
        type="button"
        className="tile"
        aria-label={
          guest.kind === 'vm'
            ? t('Open console for {name} ({kind}, {state})', { name: guest.name, kind, state: stateText })
            : t('Open shell for {name} ({kind}, {state})', { name: guest.name, kind, state: stateText })
        }
        onClick={onOpen}
      >
        <div className="tile-screen" aria-hidden="true">
          <TileBody guest={guest} thumb={thumb} blockedReason={blockedReason} />
        </div>
        <div className="tile-foot" aria-hidden="true">
          <Dot color={guestStateInfo(guest.state).color} />
          <span className="mono tile-name">{guest.name}</span>
          <span className="lbl tile-kind">{kind}</span>
        </div>
      </button>
    </li>
  );
}

export function ScreensWall({ server, guests, onOpenConsole }: ScreensWallProps) {
  const pageVisible = usePageVisible();
  const rc = server.server.remote_control;
  const blockedReason = rc && !rc.console ? (rc.console_reason ?? t('Remote control is turned off for this server')) : null;
  return (
    <ul className="screens-grid" aria-label={t('Screens')} style={{ listStyle: 'none', margin: 0 }}>
      {guests.map((g) => (
        <Tile key={g.id} serverId={server.server.id} guest={g} blockedReason={blockedReason} pageVisible={pageVisible} onOpen={() => onOpenConsole(g.id)} />
      ))}
    </ul>
  );
}
