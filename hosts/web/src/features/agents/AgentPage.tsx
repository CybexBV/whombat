// Settings › Agents › <server>: everything an admin manages for one server.
// The server (group and location, through the Edit dialog), its agent
// (connection, version, address, clock, certificate, collectors), the two
// remote-control switches next to the host's own policy, and Delete.

import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useAgents, useServers } from '../../api/queries';
import type { AgentInfo } from '../../api/types';
import { Skeleton } from '../../components/common';
import { Chip } from '../../components/controls';
import { Switch } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { useNow } from '../../lib/clock';
import { DASH, formatDay, formatFull, plural } from '../../lib/format';
import { t, tx } from '../../lib/i18n';
import { useReturnFocus } from '../../lib/useReturnFocus';
import { useTitle } from '../../lib/useTitle';
import { serverPath } from '../../lib/urlState';
import { RequireAdmin } from '../settings/SettingsLayout';
import { AgentStatus, CollectorChips, SKEW_WARN_S, skewWarning, Warn } from './agentParts';
import { AgentUpdateLine, useUpdateAgents } from './AgentUpdate';
import { rolloutRunning } from './updateView';
import { formatVersion } from './ApproveForm';
import { CAP_LABEL, CAPS, type Capability, useRemoteControl, hostConfigFix } from './remoteControl';
import { DeleteServerDialog, EditServerDialog } from './ServerDialogs';

const CAP_DESC: Record<Capability, string> = {
  console: t('Consoles and logs of this server’s guests; its process, port and service lists and journal'),
  power: t('Start, stop, restart and snapshot this server’s guests'),
  manage: t('Change, create, clone, back up, restore and delete this server’s guests (Proxmox VE, Incus)'),
  diagnose: t('Read-only checks the assistant runs: logs, SMART, arrays, services'),
  host_shell: t('A root shell on the host itself. Leave off unless you need it'),
  host_power: t('Reboot or shut down the host itself'),
};

function Crumbs({ id }: { id: string }) {
  return (
    <nav aria-label={t('Breadcrumb')} className="breadcrumb">
      <Link to="/settings/agents">{t('Agents')}</Link>
      <span className="sep" aria-hidden="true">
        /
      </span>
      <span className="mono ink" aria-current="page">
        {id}
      </span>
    </nav>
  );
}

function Clock({ skew }: { skew: number | null }) {
  if (skew == null) return <>{DASH}</>;
  if (Math.abs(skew) < SKEW_WARN_S) {
    return (
      <>
        {t('In sync')}
        <span className="lbl kv-sub">{t('{s} s from the hub', { s: Math.abs(skew).toFixed(1) })}</span>
      </>
    );
  }
  return (
    <>
      {t('{s} s off', { s: Math.abs(skew).toFixed(1) })}
      <span className="lbl kv-sub">{skew > 0 ? t('Ahead of the hub') : t('Behind the hub')}</span>
    </>
  );
}

function Certificate({ at }: { at: string | null | undefined }) {
  const now = useNow();
  if (!at) return <>{DASH}</>;
  const ts = Date.parse(at);
  const days = Math.round((ts - now) / 86_400_000);
  return (
    <>
      <time dateTime={at} title={formatFull(ts)}>
        {t('Expires {time}', { time: formatDay(ts) })}
      </time>
      <span className="lbl kv-sub">{days < 0 ? t('Expired') : days === 0 ? t('Today') : t('In {time}', { time: plural(days, 'day') })}</span>
    </>
  );
}

function RemoteControlCard({ a }: { a: AgentInfo }) {
  const rc = useRemoteControl();
  const fix = hostConfigFix(a.install);
  const [busy, setBusy] = useState<Set<Capability>>(new Set());
  const id = a.server_id;
  const toggle = (cap: Capability, value: boolean) => {
    if (busy.has(cap)) return; // one request per switch at a time
    setBusy((b) => new Set([...b, cap]));
    rc.mutate(
      { id, cap, value },
      {
        onSettled: () =>
          setBusy((b) => {
            const s = new Set(b);
            s.delete(cap);
            return s;
          }),
      },
    );
  };
  return (
    <section className="card settings-card" aria-labelledby="rc-title">
      <h2 className="h2" id="rc-title">
        {t('Remote control')}
      </h2>
      <p className="rc-note ink-2">
        <Icon name="shield" size={16} />
        <span>
          {tx('Off by default. A console or power action works only when both are on: the switch here and {console} / {power} in the agent’s config on the host. Every session and action is audited.', {
            console: <code className="mono">console = true</code>,
            power: <code className="mono">power = true</code>,
          })}
        </span>
      </p>
      <div className="rc-list">
        {CAPS.map((cap) => {
          const hub = !!a.remote_control?.[cap];
          const host = !!a.agent_policy?.[cap];
          return (
            <div key={cap} className="rc-item">
              <Switch
                checked={hub}
                busy={busy.has(cap)}
                onChange={(v) => toggle(cap, v)}
                label={
                  <>
                    {CAP_LABEL[cap]}
                    <span className="sr-only"> {t('on {id}', { id })}</span>
                  </>
                }
                description={CAP_DESC[cap]}
              />
              <div className="rc-host">
                {host ? (
                  <span className="rc-ok">
                    <Icon name="check" size={14} />
                    <span>{tx('The host allows it ({code})', { code: <code className="mono">{cap} = true</code> })}</span>
                  </span>
                ) : hub ? (
                  <Warn>
                    {tx('Turned on here, but the host does not allow it yet. On the host, set {code} under {section} in {file}, then run {cmd}.', {
                      code: <code className="mono">{cap} = true</code>,
                      section: <code className="mono">[remote_control]</code>,
                      file: <code className="mono">{fix.file}</code>,
                      cmd: <code className="mono">{fix.reload}</code>,
                    })}
                  </Warn>
                ) : (
                  <span className="lbl">{tx('The host does not allow it either ({code} in its config)', { code: <code className="mono">{cap} = false</code> })}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Everything an admin manages for one server; `embedded` drops the crumbs and title (the host page's Agent tab). */
export function AgentDetail({ id, embedded }: { id: string; embedded?: boolean }) {
  const agents = useAgents();
  const servers = useServers();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const update = useUpdateAgents();
  useReturnFocus(editing || deleting);

  const a = agents.data?.find((x) => x.server_id === id);
  if (!a) {
    if (agents.isError && !agents.data) {
      return (
        <>
          {!embedded && <Crumbs id={id} />}
          <InlineRetry title={t('Could not load the agent')} error={agents.error} onRetry={() => void agents.refetch()} />
        </>
      );
    }
    if (!agents.data) {
      return (
        <div aria-busy="true" aria-label={t('Loading {name}', { name: id })} className="form-stack">
          <Skeleton height={64} />
          <Skeleton height={200} />
          <Skeleton height={260} />
        </div>
      );
    }
    return (
      <>
        {!embedded && <Crumbs id={id} />}
        <div className="card empty-card" role="alert">
          <h1 className="h2">{t('Server not found')}</h1>
          <p className="ink-2">{tx('No enrolled server is called {name}.', { name: <span className="mono ink">{id}</span> })}</p>
          <Link to="/settings/agents" className="btn-ghost">
            {t('Back to Agents')}
          </Link>
        </div>
      </>
    );
  }

  const group = a.group ?? servers.data?.find((s) => s.id === id)?.group ?? DASH;
  const skew = skewWarning(a.clock_skew_s);
  return (
    <>
      {!embedded && (
        <div className="agent-head">
          <Crumbs id={id} />
          <header className="page-head">
            <div className="agent-title">
              <h1 className="page-title mono">{id}</h1>
              <Chip className="chip-lg">
                <AgentStatus a={a} />
              </Chip>
            </div>
            <Link to={serverPath(id, '24h')} className="btn-ghost">
              {t('View server')}
              <Icon name="arrowRight" size={16} />
            </Link>
          </header>
        </div>
      )}

      <div className="settings-grid">
        <section className="card settings-card" aria-labelledby="srv-title">
          <div className="list-card-head">
            <h2 className="h2" id="srv-title">
              {t('Server')}
            </h2>
            <button type="button" className="btn-ghost" onClick={() => setEditing(true)}>
              <Icon name="edit" size={15} />
              {t('Edit')}
              <span className="sr-only"> {id}</span>
            </button>
          </div>
          <dl className="kv-grid is-plain">
            <div>
              <dt className="lbl">{t('Group')}</dt>
              <dd>{group}</dd>
            </div>
            <div>
              <dt className="lbl">{t('Location')}</dt>
              <dd>{a.location || DASH}</dd>
            </div>
            <div>
              <dt className="lbl">{t('Host name')}</dt>
              <dd className="mono">{a.hostname || DASH}</dd>
            </div>
          </dl>
        </section>

        <section className="card settings-card" aria-labelledby="agent-title">
          <div className="list-card-head">
            <h2 className="h2" id="agent-title">
              {t('Agent')}
            </h2>
            {embedded && (
              <Chip>
                <AgentStatus a={a} />
              </Chip>
            )}
          </div>
          <dl className="kv-grid is-plain">
            <div>
              <dt className="lbl">{t('Version')}</dt>
              <dd className="form-stack-sm">
                {formatVersion(a.version)}
                <AgentUpdateLine a={a} running={rolloutRunning(agents.data ?? [])} update={update} />
              </dd>
            </div>
            <div>
              <dt className="lbl">{t('Address')}</dt>
              <dd className="mono">{a.address ?? DASH}</dd>
            </div>
            <div>
              <dt className="lbl">{t('Clock')}</dt>
              <dd>
                <Clock skew={a.clock_skew_s} />
              </dd>
            </div>
            <div>
              <dt className="lbl">{t('Certificate')}</dt>
              <dd>
                <Certificate at={a.cert_expires_at} />
              </dd>
            </div>
          </dl>
          {skew && (
            <Warn>
              {skew} {t('Check NTP on the host.')}
            </Warn>
          )}
          {a.collectors.length > 0 && (
            <div className="form-stack-sm">
              <span className="lbl">{t('Collectors')}</span>
              <CollectorChips serverId={id} collectors={a.collectors} />
            </div>
          )}
        </section>
      </div>

      <RemoteControlCard a={a} />

      <section className="card settings-card danger-card" aria-labelledby="delete-title">
        <div className="danger-row">
          <div>
            <h2 className="h3" id="delete-title">
              {t('Delete server')}
            </h2>
            <p className="lbl">{t('Revokes the agent certificate, closes live consoles and deletes the server’s metrics and alerts. The audit log is kept.')}</p>
          </div>
          <button type="button" className="btn-ghost is-serious" onClick={() => setDeleting(true)}>
            <Icon name="trash" size={15} />
            {t('Delete')}
            <span className="sr-only"> {id}</span>
          </button>
        </div>
      </section>

      {editing && <EditServerDialog id={id} onClose={() => setEditing(false)} />}
      {deleting && <DeleteServerDialog id={id} onClose={() => setDeleting(false)} onDeleted={() => navigate(embedded ? '/' : '/settings/agents', { replace: true })} />}
    </>
  );
}

export function AgentPage() {
  const { id = '' } = useParams();
  useTitle(`${id} · ${t('Agents')}`);
  return (
    <RequireAdmin title={id} text={t('Agent status, remote control and server settings are available to administrators only.')}>
      <AgentDetail id={id} />
    </RequireAdmin>
  );
}
