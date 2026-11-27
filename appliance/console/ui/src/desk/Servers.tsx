/**
 * Every server (Whombat desk-display.md DK-86; CG-258): opened by “+N more”, the same cards three to a row, worst
 * first, up to 24 from `/api/desk/servers`, the rest counted; it scrolls by touch when they don't fit. Touching one
 * opens its screen, whose swipes go through this list. Until the first answer, the glance's servers.
 */

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/react';
import type { Client } from '../lib/client';
import { type DeskServer, type DeskServersAnswer, deskErrorCode, parseServersAnswer } from '../lib/desk';
import { deskWordsCopy, fill } from '../lib/deskCopy';
import { SERVER_REFRESH_MS } from '../lib/deskServer';
import styles from './desk.module.css';
import { PageHead, ServerCard } from './parts';
import type { PageGone } from './Server';

const GONE: readonly string[] = ['locked', 'not_paired'] satisfies PageGone[];

export function ServersScreen({
  client,
  fallback,
  lock,
  onBack,
  onServer,
  onGone,
}: {
  client: Client;
  /** The glance's servers, while the first answer comes. */
  fallback: DeskServer[];
  lock: ReactNode;
  onBack: () => void;
  onServer: (list: DeskServer[], index: number) => void;
  onGone: (code: PageGone) => void;
}) {
  const t = useT();
  const DESK_WORDS = deskWordsCopy(t);

  const [answer, setAnswer] = useState<DeskServersAnswer | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    let stopped = false;
    const read = async () => {
      const res = await client.post('/api/desk/servers', {}).catch(() => null);
      if (stopped) return;
      const a = res?.status === 200 ? parseServersAnswer(res.body) : null;
      if (a) {
        setAnswer(a);
        return setUnavailable(false);
      }
      const code = res && res.status !== 200 ? deskErrorCode(res.body) : null;
      if (code && GONE.includes(code)) return gone.current(code as PageGone);
      setUnavailable(true);
    };
    void read();
    const timer = setInterval(() => void read(), SERVER_REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [client]);
  const servers = answer?.servers ?? fallback;
  const list = servers.filter((s) => s.id !== undefined);
  const more = answer?.more ?? 0;
  return (
    <div className={styles.page} data-page="servers">
      <div className={styles.pageBody}>
        <PageHead title={DESK_WORDS.servers.title} onBack={onBack}>
          {lock}
        </PageHead>
        {unavailable && <p className={styles.pageNote}>{DESK_WORDS.server.unavailable}</p>}
        <div className={styles.serversScroll}>
          <div className={styles.serverGrid}>
            {servers.map((s) => {
              const i = list.indexOf(s);
              return (
                <ServerCard
                  key={s.id ?? s.name}
                  server={s}
                  onOpen={i >= 0 ? () => onServer(list, i) : undefined}
                />
              );
            })}
          </div>
          {more > 0 && <p className={styles.serversMore}>{fill(DESK_WORDS.servers.more, { n: more })}</p>}
        </div>
      </div>
    </div>
  );
}
