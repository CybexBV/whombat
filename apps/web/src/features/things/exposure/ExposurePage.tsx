/**
 * Open to the internet (`/internet`, Whombat internet-exposure.md): every opening the proxies, tunnels and routers
 * Whombat is connected to have set up, one row each in the box's own words (the address, what it leads to, how it got
 * there, how it is protected), what is new and what is worth a look first; This is meant on those, Ask the assistant,
 * the thing it leads to and the place to change it. Then where Whombat looked and what it couldn't see there, so the
 * list never looks complete when it isn't. In the Servers place: the list beside it on a wide window.
 */
import {
  exposureAskSubject,
  exposureText,
  placeWords,
  quietToasts,
  type StatusLevel,
  startedChatPath,
} from '@whombat/client';
import { useExposure, useExposureMeant, useStartChat, useTheAgent } from '@whombat/client/react';
import type { ExposureOpening, ExposureSource, ExposureSourceState } from '@whombat/core';
import { ExternalLink, Globe } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigateHref } from '../../../app/routing/navigation';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { EmptyNote, ErrorNote, SkeletonRows } from '../../../components/ListState';
import { StatusMark } from '../../../components/StatusMark';
import { useToast } from '../../../components/Toast';
import { useWebI18n } from '../../../i18n/provider';
import { useAgentWords } from '../../../i18n/words';
import { Crumb } from '../dashboard/PageHead';
import { AppLink, Card } from '../parts';
import things from '../Things.module.css';
import styles from './Exposure.module.css';

/** A refusal's or failure's words stay up long enough to read. */
const FAILED_TOAST_MS = 6000;

/** How each place's read shows: read in full says nothing, the rest a mark beside its words. */
const SOURCE_LEVEL: Record<ExposureSourceState, StatusLevel> = {
  read: 'connected',
  partly: 'learning',
  unread: 'needsLook',
  missing: 'learning',
};

export function ExposurePage({ burrow }: { burrow: string }) {
  const { tag } = useWebI18n();
  const T = useMemo(() => exposureText(tag), [tag]);
  const toast = useToast();
  const { agent } = useTheAgent(burrow);
  const agentWords = useAgentWords(agent?.name);
  const { supported, data, isPending, isError, refetch } = useExposure(burrow);
  const undo = useMemo(() => quietToasts(tag).undo, [tag]);
  const meant = useExposureMeant(burrow, T, (message, o) => {
    if (!message) return;
    if (o?.undo) toast.show(message, { action: { label: undo, onAction: o.undo } });
    else toast.show(message, o?.failed ? { duration: FAILED_TOAST_MS } : undefined);
  });
  const start = useStartChat(burrow);
  const navigateHref = useNavigateHref();
  const ask = (o: ExposureOpening) => {
    start
      .mutateAsync({ text: o.ask, subject: exposureAskSubject(o) })
      .then((result) => {
        if (result.status === 'ok') navigateHref(startedChatPath(result.data));
        else toast.show(T.askFailed, { duration: FAILED_TOAST_MS });
      })
      .catch(() => toast.show(T.askFailed, { duration: FAILED_TOAST_MS }));
  };

  return (
    <div className={things.scroll}>
      <div className={things.page} data-page="internet">
        <Crumb href="/servers" label={placeWords(tag).servers.back} />
        <header className={styles.head}>
          <span className={styles.icon} aria-hidden="true">
            <Icon icon={Globe} size={26} />
          </span>
          <div className={styles.headText}>
            <h1 className={styles.title}>{T.title}</h1>
            {data ? <p className={styles.summary}>{data.summary}</p> : null}
          </div>
        </header>
        {!supported ? (
          <EmptyNote>{T.older}</EmptyNote>
        ) : isError && !data ? (
          <ErrorNote message={T.failed} retryLabel={T.retry} onRetry={() => void refetch()} />
        ) : isPending || !data ? (
          <section className={things.card} aria-busy="true" aria-label={T.loading}>
            <div className={styles.loading}>
              <SkeletonRows count={4} />
            </div>
          </section>
        ) : (
          <>
            {data.openings.length ? (
              <Card title={T.openings} meta={String(data.openings.length)} id="internet-openings">
                <ul className={styles.list}>
                  {data.openings.map((o) => (
                    <Opening
                      key={o.id}
                      opening={o}
                      T={T}
                      askLabel={agentWords.ask}
                      busy={meant.busy(o.id)}
                      onMeant={(value) => meant.set(o, value)}
                      onAsk={() => ask(o)}
                    />
                  ))}
                </ul>
                <p className={things.cardNote}>{data.note}</p>
              </Card>
            ) : (
              <section className={cx(things.card, styles.none)}>
                <p className={styles.noneText}>{data.summary}</p>
                <p className={styles.noneNote}>{data.note}</p>
              </section>
            )}
            {data.sources.length ? (
              <Card title={T.places} id="internet-places">
                <ul className={styles.list}>
                  {data.sources.map((s) => (
                    <Source key={`${s.thing ?? s.name}`} source={s} />
                  ))}
                </ul>
              </Card>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function Opening({
  opening: o,
  T,
  askLabel,
  busy,
  onMeant,
  onAsk,
}: {
  opening: ExposureOpening;
  T: ReturnType<typeof exposureText>;
  askLabel: string;
  busy: boolean;
  onMeant: (meant: boolean) => void;
  onAsk: () => void;
}) {
  // Meant is asked only where Whombat points something out: what is new or worth a look.
  const canMean = !o.meant && (o.isNew || !!o.risk);
  return (
    <li className={cx(styles.row, o.risk && styles.risky)} data-opening={o.id}>
      <div className={styles.main}>
        <p className={styles.what}>
          <span className={styles.address}>{o.title}</span>
          {o.isNew ? <span className={cx(styles.tag, styles.tagNew)}>{T.isNew}</span> : null}
          {o.meant ? <span className={cx(styles.tag, styles.tagMeant)}>{T.meant}</span> : null}
        </p>
        <p className={styles.via}>
          {o.via} · {o.protection.words}
        </p>
        {o.risk ? (
          <p className={styles.risk}>
            <StatusMark level="needsLook" />
            <span>
              <span className={styles.riskLabel}>{T.looks}: </span>
              {o.risk.words}
            </span>
          </p>
        ) : null}
      </div>
      <div className={styles.actions}>
        {canMean ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onMeant(true)}>
            {T.thisIsMeant}
          </Button>
        ) : o.meant ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onMeant(false)}>
            {T.pointOut}
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" onClick={onAsk}>
          {askLabel}
        </Button>
        {o.leadsTo ? (
          <AppLink href={o.leadsTo.href} className={styles.link}>
            {T.open(o.leadsTo.name)}
          </AppLink>
        ) : null}
        {o.manage ? (
          <a href={o.manage.url} target="_blank" rel="noreferrer" className={styles.link}>
            {o.manage.label}
            <Icon icon={ExternalLink} size={13} />
          </a>
        ) : null}
      </div>
    </li>
  );
}

function Source({ source: s }: { source: ExposureSource }) {
  const level = SOURCE_LEVEL[s.state];
  return (
    <li className={styles.source} data-source={s.state}>
      <span className={styles.sourceMark}>
        <StatusMark level={level} />
      </span>
      <div className={styles.main}>
        <p className={styles.sourceName}>
          {s.href ? (
            <AppLink href={s.href} className={styles.sourceLink}>
              {s.name}
            </AppLink>
          ) : (
            s.name
          )}
        </p>
        <p className={styles.via}>{s.words}</p>
      </div>
    </li>
  );
}
