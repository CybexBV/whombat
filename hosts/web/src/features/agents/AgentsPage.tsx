// Settings › Agents (CONTRACT 3): agents waiting for approval, then one row
// per enrolled server (agent connection and version, collectors, remote
// control as text). A row opens the server's settings page, where the
// switches, Edit and Delete live. Admin only.

import { useState } from 'react';
import { Link } from 'react-router';
import { useAgents, usePendingEnrollments } from '../../api/queries';
import type { AgentInfo, PendingEnrollment } from '../../api/types';
import { Skeleton } from '../../components/common';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { useNow } from '../../lib/clock';
import { DASH, formatAgoIso, formatFull, plural } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useReturnFocus } from '../../lib/useReturnFocus';
import { agentSettingsPath } from '../../lib/urlState';
import { useTitle } from '../../lib/useTitle';
import { RequireAdmin } from '../settings/SettingsLayout';
import { AgentStatus, skewWarning, Warn } from './agentParts';
import { AgentUpdateLine, useUpdateAgents } from './AgentUpdate';
import { rolloutRunning, updatableCount } from './updateView';
import { formatVersion } from './ApproveForm';
import { useOpenEnroll } from './enrollLink';
import { remoteSummary } from './remoteControl';
import { ApproveDialog, RejectDialog } from './ServerDialogs';

// ------------------------------------------------------------------ pending

function PendingSection({ list }: { list: PendingEnrollment[] }) {
  const now = useNow();
  const [approve, setApprove] = useState<PendingEnrollment | null>(null);
  const [reject, setReject] = useState<PendingEnrollment | null>(null);
  useReturnFocus(!!approve || !!reject);
  return (
    <section className="card list-card pending-card" aria-labelledby="pending-title">
      <div className="list-card-head">
        <h2 className="h2 pending-title" id="pending-title">
          <span className="warn-ic" aria-hidden="true">
            <Icon name="warning" size={18} />
          </span>
          {t('Waiting for approval')}
        </h2>
        <span className="lbl">{t('Agents that ran the install command')}</span>
      </div>
      <div className="pending-table" role="table" aria-labelledby="pending-title">
        <div className="pending-row thead" role="row">
          <span className="lbl" role="columnheader">
            {t('Host name')}
          </span>
          <span className="lbl" role="columnheader">
            {t('Operating system')}
          </span>
          <span className="lbl" role="columnheader">
            {t('Address')}
          </span>
          <span className="lbl" role="columnheader">
            {t('Agent')}
          </span>
          <span className="lbl" role="columnheader">
            {t('Requested')}
          </span>
          <span className="sr-only" role="columnheader">
            {t('Actions')}
          </span>
        </div>
        {list.map((p) => {
          const host = p.hostname ?? p.id;
          return (
            <div className="pending-row" role="row" key={p.id}>
              <span className="mono strong pr-host" role="rowheader">
                {host}
              </span>
              <span className="pr-os" role="cell">
                {p.os ?? DASH}
              </span>
              <span className="mono ink-2 pr-addr" role="cell">
                {p.address ?? DASH}
              </span>
              <span className="ink-2 pr-ver" role="cell">
                {formatVersion(p.agent_version)}
              </span>
              <span className="ink-2 pr-when" role="cell">
                {p.requested_at ? (
                  <time dateTime={p.requested_at} title={formatFull(Date.parse(p.requested_at))}>
                    {formatAgoIso(p.requested_at, now)}
                  </time>
                ) : (
                  DASH
                )}
              </span>
              <span className="row-actions" role="cell">
                <button type="button" className="btn-ghost row-action" onClick={() => setApprove(p)}>
                  <Icon name="check" size={16} />
                  {t('Approve')}
                  <span className="sr-only"> {host}</span>
                </button>
                <button type="button" className="btn-ghost row-action" onClick={() => setReject(p)}>
                  {t('Reject')}
                  <span className="sr-only"> {host}</span>
                </button>
              </span>
            </div>
          );
        })}
      </div>
      {approve && <ApproveDialog pending={approve} onClose={() => setApprove(null)} />}
      {reject && <RejectDialog pending={reject} onClose={() => setReject(null)} />}
    </section>
  );
}

// ------------------------------------------------------------------ servers

function Collectors({ a }: { a: AgentInfo }) {
  const n = a.collectors.length;
  if (!n) return <span className="ink-3">{DASH}</span>;
  const failing = a.collectors.filter((c) => !c.ok);
  if (!failing.length) return <span>{t('All {n} reporting', { n })}</span>;
  return (
    <span title={failing.map((c) => `${c.name}: ${c.error || t('not reporting')}`).join('\n')}>
      <Warn>{t('{n} of {total} not reporting', { n: failing.length, total: n })}</Warn>
    </span>
  );
}

function AgentRow({ a, running, update }: { a: AgentInfo; running: boolean; update: ReturnType<typeof useUpdateAgents> }) {
  const id = a.server_id;
  const rc = remoteSummary(a);
  const skew = skewWarning(a.clock_skew_s);
  const sub = [a.group, a.hostname && a.hostname !== id ? t('host {name}', { name: a.hostname }) : null].filter(Boolean).join(' · ');
  return (
    <li className="agent-row">
      <div className="agent-cell ac-name">
        <Link to={agentSettingsPath(id)} className="mono agent-name agent-link">
          {id}
        </Link>
        {sub && <span className="lbl">{sub}</span>}
      </div>
      <div className="agent-cell ac-agent">
        <span className="cell-label lbl">{t('Agent')}</span>
        <AgentStatus a={a} />
        <span className="lbl">{a.version ? formatVersion(a.version) : t('Version unknown')}</span>
        <AgentUpdateLine a={a} running={running} update={update} />
        {skew && <Warn>{skew}</Warn>}
      </div>
      <div className="agent-cell ac-coll">
        <span className="cell-label lbl">{t('Collectors')}</span>
        <Collectors a={a} />
      </div>
      <div className="agent-cell ac-rc">
        <span className="cell-label lbl">{t('Remote control')}</span>
        {rc.warn ? <Warn>{rc.text}</Warn> : <span className={rc.text === t('Off') ? 'ink-3' : undefined}>{rc.text}</span>}
      </div>
      <Icon name="chevronRight" size={16} className="agent-chev" />
    </li>
  );
}

function AgentsAdmin() {
  const agents = useAgents();
  const pending = usePendingEnrollments(true, false);
  const openEnroll = useOpenEnroll();
  const list = agents.data ?? [];
  const connected = list.filter((a) => a.connected).length;
  const pendingList = pending.data ?? [];
  const update = useUpdateAgents();
  const running = rolloutRunning(list);
  const updatable = updatableCount(list);

  return (
    <>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t('Agents')}</h1>
          <p className="page-sub">
            {agents.data
              ? `${plural(list.length, 'server')} · ${t('{n} connected', { n: connected })}${pendingList.length ? ` · ${t('{n} waiting for approval', { n: pendingList.length })}` : ''}`
              : ' '}
          </p>
        </div>
        <div className="page-controls">
          {updatable > 0 && (
            <button
              type="button"
              className="btn-ghost"
              aria-disabled={running || update.isPending || undefined}
              title={running ? t('An update is running') : t('Update {agents} to the hub’s build, one at a time', { agents: plural(updatable, 'agent') })}
              onClick={() => !running && !update.isPending && update.mutate([])}
            >
              <Icon name="download" size={15} />
              {t('Update all ({n})', { n: updatable })}
            </button>
          )}
          <button type="button" className="btn-primary" onClick={() => openEnroll()}>
            <Icon name="plus" size={16} />
            {t('Enroll a server')}
          </button>
        </div>
      </header>

      {pendingList.length > 0 && <PendingSection list={pendingList} />}
      <section className="card agents-card" aria-labelledby="servers-title">
        <div className="agents-card-head">
          <h2 className="h2" id="servers-title">
            {t('Servers')}
          </h2>
          <span className="lbl">{t('Open a server to edit it or change remote control')}</span>
        </div>
        {agents.isError && !agents.data ? (
          <div className="agents-card-body">
            <InlineRetry title={t('Could not load the agents')} error={agents.error} onRetry={() => void agents.refetch()} />
          </div>
        ) : !agents.data ? (
          <div aria-busy="true" aria-label={t('Loading agents')} className="agents-card-body form-stack">
            <Skeleton height={56} />
            <Skeleton height={56} />
          </div>
        ) : list.length === 0 ? (
          <div className="agents-card-body">
            <div className="alert-empty">{t('No servers are enrolled yet. Use “Enroll a server” to add the first one.')}</div>
          </div>
        ) : (
          <div className="agent-table">
            <div className="agent-row thead" aria-hidden="true">
              <span className="lbl ac-name">{t('Server')}</span>
              <span className="lbl ac-agent">{t('Agent')}</span>
              <span className="lbl ac-coll">{t('Collectors')}</span>
              <span className="lbl ac-rc">{t('Remote control')}</span>
            </div>
            <ul className="plain-list" aria-label={t('Enrolled servers')}>
              {list.map((a) => (
                <AgentRow key={a.server_id} a={a} running={running} update={update} />
              ))}
            </ul>
          </div>
        )}
      </section>
    </>
  );
}

export function AgentsPage() {
  useTitle(t('Agents'));
  return (
    <RequireAdmin title={t('Agents')} text={t('Enrolling servers, agent status and the remote-control switches are available to administrators only.')}>
      <AgentsAdmin />
    </RequireAdmin>
  );
}
