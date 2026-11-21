import type { AndroidDownload } from '@whombat/client/managed';
import { Smartphone } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button, ButtonLink } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { SectionLabel } from '../../components/SectionLabel';
import { formatDownloadSize, MOBILE_TEXT } from './copy';
import styles from './mobile.module.css';

export type DownloadLoader = () => Promise<AndroidDownload | null>;

/** The APK, none published (`null`), still asking, or the question failed. */
export type DownloadState = AndroidDownload | null | 'loading' | 'failed';

export interface AndroidDownloadQuery {
  state: DownloadState;
  /** Asks again (after a failed check). */
  retry: () => void;
}

/** The Android APK control hands out (CT-191), asked for once per mount and again on `retry`. No loader: nothing asked. */
export function useAndroidDownload(load: DownloadLoader | null): AndroidDownloadQuery {
  const [state, setState] = useState<DownloadState>('loading');
  const [round, setRound] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` asks again
  useEffect(() => {
    if (!load) return;
    let live = true;
    setState('loading');
    load().then(
      (d) => live && setState(d),
      () => live && setState('failed'),
    );
    return () => {
      live = false;
    };
  }, [load, round]);
  const retry = useCallback(() => setRound((r) => r + 1), []);
  return { state, retry };
}

/**
 * “Get the app” (AP-525): the APK while the app isn't in the stores (a plain link to control's file, served as an
 * attachment), its size and what Android asks the first time; then the iPhone app, in testing on TestFlight, with a
 * way to ask for an invite. Give it `download` when the page needs the answer too (the Mobile app page's steps), or
 * `load` and it asks by itself.
 */
export function DownloadCard({
  load,
  download,
  className,
}: {
  load?: DownloadLoader;
  download?: AndroidDownloadQuery;
  className?: string;
}) {
  const t = MOBILE_TEXT.download;
  const own = useAndroidDownload(download ? null : (load ?? null));
  const { state, retry } = download ?? own;
  const ready = typeof state === 'object' && state !== null;
  return (
    <section className={cx(styles.section, className)} aria-label={t.label}>
      <SectionLabel as="h2">{t.label}</SectionLabel>
      <div className={styles.card} data-testid="android-download">
        <div className={styles.downloadRow}>
          <span className={styles.appTile} aria-hidden="true">
            <Icon icon={Smartphone} size={22} />
          </span>
          <div className={styles.downloadText}>
            <span className={styles.downloadName}>{t.name}</span>
            <span className={ready ? styles.downloadMeta : styles.downloadNote} aria-live="polite">
              {state === 'loading'
                ? t.loading
                : state === 'failed'
                  ? t.failed
                  : state === null
                    ? t.none
                    : t.meta(state.version, formatDownloadSize(state.size))}
            </span>
          </div>
          {ready ? (
            <ButtonLink
              variant="primary"
              size="xl"
              className={styles.downloadButton}
              href={state.url}
              download
              iconStart={<Icon name="download" size={16} />}
            >
              {t.button}
            </ButtonLink>
          ) : state === 'failed' ? (
            <Button variant="secondary" size="lg" className={styles.downloadButton} onClick={retry}>
              {t.retry}
            </Button>
          ) : null}
        </div>
        {ready && <p className={styles.downloadHint}>{t.hint}</p>}
        <div className={cx(styles.downloadRow, styles.downloadRowNext)} data-testid="iphone-download">
          <span className={styles.appTile} aria-hidden="true">
            <Icon icon={Smartphone} size={22} />
          </span>
          <div className={styles.downloadText}>
            <span className={styles.downloadName}>{t.iphoneName}</span>
            <span className={styles.downloadNote}>{t.iphoneMeta}</span>
          </div>
          <ButtonLink variant="secondary" size="lg" className={styles.downloadButton} href={t.iphoneMail}>
            {t.iphoneAsk}
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
