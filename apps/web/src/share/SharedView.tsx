/**
 * The page a shared link opens (docs/decisions/share-links.md): the hosted app's `/s/<id>#<key>`. It fetches the sealed
 * copy from control, opens it here with the key from the fragment (which never left the browser) and shows it read-only.
 * No sign-in, no session with any Whombat, nothing to reply with. It is in the visitor's language (`?lang=`, else their
 * browser's), never the language of the person who shared it.
 */
import { HumanAvatar, WhombatAvatar } from '@whombat/avatars/react';
import { AgentFace, initialsOf } from '@whombat/core';
import { openSnapshot, parseShareLocation, type SharedSnapshot, sharePublicPath } from '@whombat/core/share';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../components/Button';
import { HtmlPreviewCard } from '../features/messaging/HtmlPreview';
import { RichText } from '../features/messaging/RichText';
import { LanguageSwitch } from '../i18n/LanguageSwitch';
import { useWebI18n, WebI18nProvider } from '../i18n/provider';
import styles from './SharedView.module.css';

type State =
  | { kind: 'loading' }
  | { kind: 'incomplete' }
  | { kind: 'gone' }
  | { kind: 'unreadable' }
  | { kind: 'offline' }
  | { kind: 'ready'; snapshot: SharedSnapshot };

/** Loads and opens the copy the location names. `fetchBytes` answers null for a link control no longer keeps. */
export async function loadShared(
  location: { pathname: string; hash: string },
  fetchBytes: (id: string) => Promise<Uint8Array | null>,
): Promise<State> {
  const at = parseShareLocation(location.pathname, location.hash);
  if (!at) return { kind: 'incomplete' };
  let bytes: Uint8Array | null;
  try {
    bytes = await fetchBytes(at.id);
  } catch {
    return { kind: 'offline' };
  }
  if (!bytes) return { kind: 'gone' };
  const snapshot = openSnapshot(bytes, at.id, at.key);
  return snapshot ? { kind: 'ready', snapshot } : { kind: 'unreadable' };
}

/** The copy's bytes from control; null on 404 (stopped or expired). */
export function controlFetcher(controlUrl: string) {
  const base = controlUrl.replace(/\/+$/, '');
  return async (id: string): Promise<Uint8Array | null> => {
    const res = await fetch(`${base}${sharePublicPath(id)}`, {
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new Error(`share ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

function Notice({ title, text, onRetry }: { title: string; text: string; onRetry?: () => void }) {
  const { t } = useWebI18n();
  return (
    <main className={styles.notice}>
      <h1 className={styles.noticeTitle}>{title}</h1>
      <p className={styles.noticeText}>{text}</p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          {t('common.tryAgain')}
        </Button>
      )}
      <LanguageSwitch />
    </main>
  );
}

export function SharedConversation({ snapshot }: { snapshot: SharedSnapshot }) {
  const pictures = useMemo(
    () => new Map(snapshot.pictures.map((p) => [p.id, `data:${p.mime};base64,${toBase64(p.data)}`])),
    [snapshot],
  );
  const face = AgentFace.safeParse(snapshot.assistant.face);
  const personInitials = initialsOf(snapshot.person.name);
  const { t, locale } = useWebI18n();
  const dayFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }),
    [locale],
  );
  const timeFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }),
    [locale],
  );
  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <p className={styles.kicker}>{t('share.kicker')}</p>
        <h1 className={styles.title}>{snapshot.title}</h1>
        <p className={styles.meta}>
          {t('share.sharedOn', { name: snapshot.person.name, day: dayFormat.format(snapshot.sharedAt) })}
        </p>
      </header>
      <ol className={styles.messages}>
        {snapshot.messages.map((m, i) => {
          const name = m.from === 'person' ? snapshot.person.name : snapshot.assistant.name;
          return (
            // A snapshot never changes, so its order is its identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: the copy is frozen
            <li key={i} className={styles.message}>
              {m.from === 'person' ? (
                <HumanAvatar initials={personInitials} size={40} />
              ) : (
                <WhombatAvatar face={face.success ? face.data : 'dusty'} size={40} />
              )}
              <div className={styles.content}>
                <p className={styles.line}>
                  <span className={styles.name}>{name}</span>
                  <time className={styles.time} dateTime={new Date(m.at).toISOString()}>
                    {timeFormat.format(m.at)}
                  </time>
                </p>
                {m.text && <RichText text={m.text} />}
                {m.pictures?.map((id) => {
                  const src = pictures.get(id);
                  return src ? <img key={id} className={styles.picture} src={src} alt="" /> : null;
                })}
                {m.pages?.map((page, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the copy is frozen
                  <HtmlPreviewCard key={j} html={page.html} fallbackTitle={page.title} />
                ))}
              </div>
            </li>
          );
        })}
      </ol>
      <footer className={styles.foot}>
        {t('share.foot', { name: snapshot.person.name })}
        <LanguageSwitch />
      </footer>
    </main>
  );
}

/** base64url → base64 for a data URL. */
function toBase64(data: string): string {
  const b = data.replace(/-/g, '+').replace(/_/g, '/');
  return b + '='.repeat((4 - (b.length % 4)) % 4);
}

export function SharedView({ fetchBytes }: { fetchBytes: (id: string) => Promise<Uint8Array | null> }) {
  return (
    <WebI18nProvider scope="visitor">
      <SharedPage fetchBytes={fetchBytes} />
    </WebI18nProvider>
  );
}

function SharedPage({ fetchBytes }: { fetchBytes: (id: string) => Promise<Uint8Array | null> }) {
  const { t } = useWebI18n();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const load = useCallback(() => {
    setState({ kind: 'loading' });
    void loadShared(window.location, fetchBytes).then(setState);
  }, [fetchBytes]);
  useEffect(load, [load]);
  useEffect(() => {
    document.title = state.kind === 'ready' ? `${state.snapshot.title} · Whombat` : t('share.documentTitle');
  }, [state, t]);
  switch (state.kind) {
    case 'loading':
      return <main className={styles.notice} aria-busy="true" />;
    case 'incomplete':
      return <Notice title={t('share.incomplete.title')} text={t('share.incomplete.text')} />;
    case 'gone':
      return <Notice title={t('share.gone.title')} text={t('share.gone.text')} />;
    case 'unreadable':
      return <Notice title={t('share.unreadable.title')} text={t('share.unreadable.text')} />;
    case 'offline':
      return <Notice title={t('share.offline.title')} text={t('share.offline.text')} onRetry={load} />;
    case 'ready':
      return <SharedConversation snapshot={state.snapshot} />;
  }
}
