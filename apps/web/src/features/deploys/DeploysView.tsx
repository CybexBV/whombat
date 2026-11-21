import { WhombatAvatar } from '@whombat/avatars/react';
import { agentFaceOf } from '@whombat/client';
import { useDeployEnvironments, useDeployments, useWhombat } from '@whombat/client/react';
import { DEPLOYMENT_STATUS_PILLS, type Deployment, formatAgo, type Principal } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { cx } from '../../components/cx';
import { EmptyNote, ErrorNote, SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { Tag } from '../../components/Tag';
import { PersonAvatar } from '../messaging/PersonAvatar';
import { useBurrowViewer } from '../runs/useBurrowViewer';
import styles from './Deploys.module.css';
import {
  DEPLOYS_TEXT,
  environmentNames,
  historyLine,
  howText,
  previousText,
  type ServiceRow,
  serviceRow,
  versionText,
} from './deploysModel';

/**
 * Deploys' content (docs/decisions/web-efficiency.md WE-17, work-removal.md AP-850): the environments board — per
 * environment its services, each with the live version, who deployed it and when, its link, a newer failed attempt and
 * the version before — then the history, newest first, by environment. Live through `deployment.recorded` (the board
 * and the history read again). The board is the sidebar row's read too (`useShowsDeploys`), so it opens from the cache.
 */
export function DeploysView({ burrow }: { burrow: string }) {
  const board = useDeployEnvironments({ params: { burrow } }, { retry: false });
  const [environment, setEnvironment] = useState<string | null>(null);
  const viewer = useBurrowViewer(burrow);
  const now = Date.now();
  const when = (d: Deployment) => formatAgo(d.createdAt, now, viewer.timeZone);
  const environments = board.data?.environments ?? [];

  return (
    <>
      <section className={styles.group} aria-labelledby="deploys-environments">
        <SectionLabel as="h2" id="deploys-environments" className={styles.groupLabel}>
          {DEPLOYS_TEXT.environments}
        </SectionLabel>
        {board.error && !board.data ? (
          <ErrorNote message={DEPLOYS_TEXT.loadFailed} onRetry={() => void board.refetch()} />
        ) : !board.data ? (
          <SkeletonRows count={3} avatarSize={28} lines={2} />
        ) : environments.length === 0 ? (
          <EmptyNote className={styles.empty}>{DEPLOYS_TEXT.empty}</EmptyNote>
        ) : (
          environments.map((env) => (
            <section
              key={env.environment}
              className={styles.environment}
              aria-label={env.environment}
              data-deploy-environment={env.environment}
            >
              <h3 className={styles.envName}>
                {env.environment}
                <span className={styles.envMeta}>
                  {env.services.length} {env.services.length === 1 ? 'service' : 'services'}
                </span>
              </h3>
              {env.services.map((s) => (
                <BoardRow
                  key={s.service}
                  row={serviceRow(env.environment, s)}
                  principal={viewer.principal}
                  shortName={viewer.shortName}
                  when={when}
                />
              ))}
            </section>
          ))
        )}
      </section>
      {environments.length > 0 && (
        <History
          burrow={burrow}
          environments={environmentNames(environments)}
          environment={environment}
          onEnvironment={setEnvironment}
          principal={viewer.principal}
          shortName={viewer.shortName}
          when={when}
        />
      )}
    </>
  );
}

interface PeopleProps {
  principal: (id: string) => Principal | undefined;
  shortName: (id: string) => string;
  when: (d: Deployment) => string;
}

/** A service on the board: name · live version · by · when · link · pill, a failed attempt and the previous version. */
function BoardRow({ row, principal, shortName, when }: { row: ServiceRow } & PeopleProps) {
  const live = row.live;
  const previous = previousText(row.previous);
  return (
    <div className={styles.row} data-deploy-service={row.service}>
      <span className={styles.service}>{row.service}</span>
      <span className={styles.content}>
        {live ? (
          <>
            <span className={styles.line}>
              <span className={styles.version}>{versionText(live)}</span>
              <By id={live.byId} principal={principal} shortName={shortName} />
              <span className={styles.meta}>{when(live)}</span>
              {live.url && <ExternalLink href={live.url} />}
            </span>
            {live.summary && <span className={styles.summary}>{live.summary}</span>}
          </>
        ) : (
          <span className={styles.meta}>{DEPLOYS_TEXT.noLive}</span>
        )}
        {row.failed && (
          <span className={cx(styles.line, styles.failed)}>
            <span className={styles.version}>{versionText(row.failed)}</span>
            <span>
              failed {when(row.failed)}
              {row.failed.summary ? `: ${row.failed.summary}` : ''}
            </span>
          </span>
        )}
        {previous && <span className={styles.meta}>{previous}</span>}
      </span>
      <Tag variant="outline" tone={row.pill.tone} className={styles.pill}>
        {row.pill.text}
      </Tag>
    </div>
  );
}

function By({ id, principal, shortName }: { id: string } & Omit<PeopleProps, 'when'>) {
  const p = principal(id);
  return (
    <span className={styles.by}>
      {p?.kind === 'agent' ? (
        <WhombatAvatar face={agentFaceOf(p)} crop="head" size={18} label={p.name} />
      ) : p?.kind === 'person' ? (
        <PersonAvatar avatarUrl={p.avatarUrl} initials={p.initials} tone={p.tone} size={18} label={p.name} />
      ) : null}
      <span>{shortName(id)}</span>
    </span>
  );
}

function ExternalLink({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={styles.link}>
      {DEPLOYS_TEXT.open}
      <span className={styles.srOnly}> {href} (opens in a new tab)</span>
    </a>
  );
}

/** Every recorded deploy, newest first; chips by environment; “Load more” by the page's cursor. */
function History({
  burrow,
  environments,
  environment,
  onEnvironment,
  ...people
}: {
  burrow: string;
  environments: string[];
  environment: string | null;
  onEnvironment: (environment: string | null) => void;
} & PeopleProps) {
  const { client } = useWhombat();
  const query = environment ? { environment } : {};
  const first = useDeployments({ params: { burrow }, query }, { retry: false });
  const [more, setMore] = useState<{ deployments: Deployment[]; before: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Another filter, or the first page read again (a new deploy): the extra pages start over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets when the first page changes
  useEffect(() => setMore(null), [first.data, environment]);
  const rows = [...(first.data?.deployments ?? []), ...(more?.deployments ?? [])];
  const before = more ? more.before : (first.data?.before ?? null);
  const loadMore = async () => {
    if (!before) return;
    setLoadingMore(true);
    try {
      const page = await client.request(api.deployments.list, {
        params: { burrow },
        query: { ...query, before },
      });
      if (page.status !== 'ok') return;
      const { deployments, before: next } = page.data;
      setMore((m) => ({ deployments: [...(m?.deployments ?? []), ...deployments], before: next }));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section className={styles.group} aria-labelledby="deploys-history">
      <SectionLabel as="h2" id="deploys-history" className={styles.groupLabel}>
        {DEPLOYS_TEXT.history}
      </SectionLabel>
      {environments.length > 1 && (
        <div className={styles.filters}>
          <Chip active={environment === null} onClick={() => onEnvironment(null)}>
            {DEPLOYS_TEXT.all}
          </Chip>
          {environments.map((e) => (
            <Chip key={e} active={environment === e} onClick={() => onEnvironment(e)}>
              {e}
            </Chip>
          ))}
        </div>
      )}
      {first.error && !first.data ? (
        <ErrorNote message={DEPLOYS_TEXT.loadFailed} onRetry={() => void first.refetch()} />
      ) : !first.data ? (
        <SkeletonRows count={4} avatarSize={28} lines={2} />
      ) : rows.length === 0 ? (
        <EmptyNote className={styles.empty}>{DEPLOYS_TEXT.emptyFilter}</EmptyNote>
      ) : (
        rows.map((d) => (
          <div key={d.id} className={styles.historyRow} data-deployment={d.id}>
            <span className={styles.content}>
              <span className={cx(styles.historyLine, d.status === 'failed' && styles.failed)}>
                {historyLine(d)}
              </span>
              <span className={styles.line}>
                <By id={d.byId} principal={people.principal} shortName={people.shortName} />
                <span className={styles.meta}>
                  {howText(d)} · {people.when(d)}
                </span>
                {d.url && <ExternalLink href={d.url} />}
              </span>
              {d.summary && <span className={styles.summary}>{d.summary}</span>}
            </span>
            <Tag variant="outline" tone={d.status === 'failed' ? 'bad' : 'ok'} className={styles.pill}>
              {DEPLOYMENT_STATUS_PILLS[d.status]}
            </Tag>
          </div>
        ))
      )}
      {before && rows.length > 0 && (
        <Button
          variant="secondary"
          size="md"
          className={styles.loadMore}
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? 'Loading…' : DEPLOYS_TEXT.loadMore}
        </Button>
      )}
    </section>
  );
}
