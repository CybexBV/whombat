/**
 * Settings → You → **Shared links** (docs/decisions/share-links.md): every link the person made, newest first, with how
 * long it works and how often it was opened; Copy link and Stop sharing on the ones that work, and Stop all links.
 */
import { SHARE_TEXT, shareLinkLine } from '@whombat/client';
import { shareErrorText, useShares, useStopAllShares, useStopShare } from '@whombat/client/react';
import { Button } from '../../components/Button';
import { copyText } from '../../components/CopyButton';
import { SectionLabel } from '../../components/SectionLabel';
import { useToast } from '../../components/Toast';
import styles from './SettingsScreen.module.css';
import own from './SharedLinks.module.css';

export function SharedLinks({ burrow }: { burrow: string }) {
  const list = useShares({ params: { burrow } });
  const stop = useStopShare(burrow);
  const stopAll = useStopAllShares(burrow);
  const toast = useToast();
  const links = list.data?.shares ?? [];
  const live = links.filter((l) => l.state === 'live');
  const failed = (e: unknown) => toast.show(shareErrorText(e, SHARE_TEXT.failed));
  return (
    <section className={styles.section} aria-label={SHARE_TEXT.settingsTitle} data-testid="shared-links">
      <SectionLabel as="h2">{SHARE_TEXT.settingsTitle}</SectionLabel>
      <p className={own.intro}>{SHARE_TEXT.settingsNote}</p>
      <div className={styles.card}>
        {list.isError ? (
          <div className={styles.row}>
            <span className={styles.rowMain}>
              <span className={styles.rowMeta}>{shareErrorText(list.error, SHARE_TEXT.failed)}</span>
            </span>
            <Button variant="secondary" size="sm" onClick={() => void list.refetch()}>
              Try again
            </Button>
          </div>
        ) : list.isLoading ? (
          <div className={styles.row} aria-busy="true">
            <span className={styles.rowMain}>
              <span className={styles.rowMeta}>Loading…</span>
            </span>
          </div>
        ) : links.length === 0 ? (
          <div className={styles.row}>
            <span className={styles.rowMain}>
              <span className={styles.rowMeta}>{SHARE_TEXT.settingsEmpty}</span>
            </span>
          </div>
        ) : (
          links.map((l) => (
            <div key={l.id} className={styles.row} data-share-row={l.state}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{l.title}</span>
                <span className={styles.rowMeta}>{shareLinkLine(l)}</span>
              </span>
              {l.state === 'live' && (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`${SHARE_TEXT.copy}: ${l.title}`}
                    onClick={() => void copyText(l.url).then((ok) => ok && toast.show(SHARE_TEXT.copied))}
                  >
                    {SHARE_TEXT.copy}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={stop.isPending && stop.variables === l.id}
                    aria-label={`${SHARE_TEXT.stop}: ${l.title}`}
                    onClick={() => stop.mutate(l.id, { onError: failed })}
                  >
                    {stop.isPending && stop.variables === l.id ? SHARE_TEXT.stopping : SHARE_TEXT.stop}
                  </Button>
                </>
              )}
            </div>
          ))
        )}
      </div>
      {live.length > 1 && (
        <div className={own.foot}>
          <Button
            variant="secondary"
            size="sm"
            disabled={stopAll.isPending}
            onClick={() => {
              if (window.confirm(`Stop all ${live.length} links? Nobody can open them any more.`))
                stopAll.mutate(undefined, { onError: failed });
            }}
          >
            {stopAll.isPending ? SHARE_TEXT.stopping : SHARE_TEXT.stopAll}
          </Button>
        </div>
      )}
    </section>
  );
}
