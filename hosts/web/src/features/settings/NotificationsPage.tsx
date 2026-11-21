// Settings › Notifications (admin): where alerts are sent. Channels
// (ntfy, a webhook, or any service Shoutrrr knows by URL), the recent
// deliveries, and the hub's own heartbeat for an external monitor.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api } from '../../api/client';
import { useGroups } from '../../api/queries';
import type { Channel, ChannelInput, ChannelKind, Delivery } from '../../api/types';
import { Skeleton } from '../../components/common';
import { Chip, Dot, SegmentedControl } from '../../components/controls';
import { errorText, InlineError, SelectField, Switch, TextField } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { InlineRetry } from '../../components/InlineRetry';
import { Menu } from '../../components/Menu';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { useNow } from '../../lib/clock';
import { formatAgoIso, formatFull, plural } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useTitle } from '../../lib/useTitle';
import { RequireAdmin } from './SettingsLayout';

const KIND_LABEL: Record<ChannelKind, string> = { ntfy: 'ntfy', webhook: 'Webhook', shoutrrr: 'Service URL' };
const REMIND = [
  { value: '0', label: t('Never') },
  { value: '60', label: t('Hourly') },
  { value: '240', label: t('Every 4 h') },
  { value: '1440', label: t('Daily') },
] as const;
// A channel's last delivery: "last reminder 5 min ago".
const LAST_DELIVERY: Record<Delivery['kind'], (time: string) => string> = {
  opened: (time) => t('last opened {time}', { time }),
  resolved: (time) => t('last resolved {time}', { time }),
  reminder: (time) => t('last reminder {time}', { time }),
  test: (time) => t('last test {time}', { time }),
  heartbeat: (time) => t('last heartbeat {time}', { time }),
};

const qkChannels = ['channels'] as const;
const qkDeliveries = ['deliveries'] as const;
const qkNotify = ['notifySettings'] as const;

function filterText(c: Channel): string {
  const parts = [c.min_severity === 'critical' ? t('Critical alerts') : t('All alerts')];
  if (c.groups.length) parts.push(c.groups.join(', '));
  if (c.reminder_min > 0) parts.push(t('reminds {interval}', { interval: REMIND.find((r) => r.value === String(c.reminder_min))?.label.toLowerCase() ?? t('every {n} min', { n: c.reminder_min }) }));
  if (!c.send_resolved) parts.push(t('no resolved notices'));
  return parts.join(' · ');
}

function ChannelDialog({ channel, onClose }: { channel: Channel | null; onClose: () => void }) {
  const qc = useQueryClient();
  const groups = useGroups();
  const editing = channel !== null;
  const [kind, setKind] = useState<ChannelKind>(channel?.kind ?? 'ntfy');
  const [name, setName] = useState(channel?.name ?? '');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [auth, setAuth] = useState('');
  const [format, setFormat] = useState(channel?.format || 'rackoon');
  const [severity, setSeverity] = useState<'warning' | 'critical'>(channel?.min_severity ?? 'warning');
  const [group, setGroup] = useState(channel?.groups[0] ?? '');
  const [remind, setRemind] = useState(String(channel?.reminder_min ?? 0));
  const [resolved, setResolved] = useState(channel?.send_resolved ?? true);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);

  const input = (): ChannelInput => {
    const c: ChannelInput = { name, kind, min_severity: severity, groups: group ? [group] : [], reminder_min: Number(remind), send_resolved: resolved };
    if (url) c.url = url;
    if (kind === 'ntfy' && token) c.token = token;
    if (kind === 'webhook') {
      c.format = format;
      if (auth) c.headers = { Authorization: auth };
    }
    return c;
  };
  const save = useMutation({
    mutationFn: () => (editing ? api.patchChannel(channel.id, input()) : api.createChannel(input())),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qkChannels });
      toast(editing ? t('Channel saved.') : t('Channel added. Send a test to check it.'), 'success');
      onClose();
    },
    onError: (err) => setError(errorText(err)),
  });
  const test = async () => {
    setError('');
    setTesting(true);
    try {
      const r = editing && !url ? await api.testChannel(channel.id) : await api.testChannelConfig(input());
      if (r.ok) toast(t('Test notification sent.'), 'success');
      else setError(t('The test failed: {error}', { error: r.error }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setTesting(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) return setError(t('Give the channel a name.'));
    if (!editing && !url.trim()) return setError(t('Give the URL.'));
    save.mutate();
  };
  const urlHint =
    kind === 'ntfy'
      ? t('The topic URL: https://ntfy.sh/<your-topic> or your own ntfy server.')
      : kind === 'webhook'
        ? t('Rackoon POSTs a JSON document to this URL.')
        : t('A Shoutrrr URL, e.g. discord://token@channel, telegram://token@telegram?chats=@chat, smtp://user:pass@host:587/?from=…&to=…, gotify://host/token, pushover://shoutrrr:token@user, matrix://user:pass@host.');
  return (
    <Modal
      open
      onClose={onClose}
      busy={save.isPending}
      wide
      title={editing ? t('Edit {name}', { name: channel.name }) : t('New channel')}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={() => void test()} disabled={testing || save.isPending || (!editing && !url)}>
            {testing ? t('Sending…') : t('Send test')}
          </button>
          <span className="spacer" />
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" form="channel-form" className="btn-primary" disabled={save.isPending}>
            {editing ? t('Save') : t('Add channel')}
          </button>
        </>
      }
    >
      <form id="channel-form" className="form-stack" onSubmit={submit}>
        {!editing && (
          <SegmentedControl
            label={t('Type')}
            options={(['ntfy', 'webhook', 'shoutrrr'] as const).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
            value={kind}
            onChange={setKind}
          />
        )}
        <TextField label={t('Name')} value={name} maxLength={64} autoFocus placeholder={t('Phone')} onChange={(e) => setName(e.target.value)} />
        <TextField
          label="URL"
          mono
          value={url}
          placeholder={editing ? t('{target} (unchanged)', { target: channel.target }) : kind === 'ntfy' ? 'https://ntfy.sh/rackoon-alerts' : kind === 'webhook' ? 'https://example.com/hooks/rackoon' : 'discord://token@channel'}
          hint={urlHint}
          onChange={(e) => setUrl(e.target.value)}
          autoComplete="off"
        />
        {kind === 'ntfy' && (
          <TextField label={t('Access token (optional)')} type="password" value={token} placeholder={channel?.has_token ? t('Set (unchanged)') : 'tk_…'} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        )}
        {kind === 'webhook' && (
          <>
            <SegmentedControl
              label={t('Format')}
              options={[
                { value: 'rackoon', label: 'Rackoon JSON' },
                { value: 'alertmanager', label: 'Alertmanager' },
              ]}
              value={format}
              onChange={setFormat}
            />
            <TextField label={t('Authorization header (optional)')} type="password" value={auth} placeholder={channel?.header_names.length ? t('Set (unchanged)') : 'Bearer …'} onChange={(e) => setAuth(e.target.value)} autoComplete="off" />
          </>
        )}
        <SegmentedControl
          label={t('Send')}
          options={[
            { value: 'warning', label: t('All alerts') },
            { value: 'critical', label: t('Critical only') },
          ]}
          value={severity}
          onChange={setSeverity}
        />
        <SelectField label={t('Hosts')} value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">{t('Every group')}</option>
          {(groups.data ?? []).map((g) => (
            <option key={g} value={g}>
              {t('Group {name}', { name: g })}
            </option>
          ))}
        </SelectField>
        <SegmentedControl label={t('Remind while open')} options={REMIND.map((r) => ({ value: r.value, label: r.label }))} value={remind} onChange={setRemind} />
        <Switch checked={resolved} onChange={setResolved} label={t('Tell when an alert resolves')} />
        {error && <InlineError>{error}</InlineError>}
      </form>
    </Modal>
  );
}

function ChannelRow({ c, onEdit }: { c: Channel; onEdit: () => void }) {
  const qc = useQueryClient();
  const now = useNow();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qkChannels });
    void qc.invalidateQueries({ queryKey: qkDeliveries });
  };
  const toggle = useMutation({ mutationFn: (v: boolean) => api.patchChannel(c.id, { enabled: v }), onSettled: refresh, onError: (err) => toast(errorText(err), 'error') });
  const del = useMutation({ mutationFn: () => api.deleteChannel(c.id), onSettled: refresh, onError: (err) => toast(errorText(err), 'error') });
  const test = useMutation({
    mutationFn: () => api.testChannel(c.id),
    onSuccess: (r) => (r.ok ? toast(t('Test sent to {name}.', { name: c.name }), 'success') : toast(t('Test to {name} failed: {error}', { name: c.name, error: r.error }), 'error')),
    onError: (err) => toast(errorText(err), 'error'),
    onSettled: refresh,
  });
  const last = c.last_delivery;
  return (
    <li className="ch-row">
      <Switch checked={c.enabled} busy={toggle.isPending} onChange={(v) => toggle.mutate(v)} label={<span className="sr-only">{t('{name} enabled', { name: c.name })}</span>} />
      <div className="ch-main">
        <div className="ch-line1">
          <span className="strong">{c.name}</span>
          <Chip className="chip-sm">{KIND_LABEL[c.kind]}</Chip>
          <span className="mono lbl ch-target">{c.target}</span>
        </div>
        <div className="lbl">
          {filterText(c)}
          {last && (
            <>
              {' · '}
              <span title={formatFull(Date.parse(last.at))}>
                <Dot color={last.ok ? 'var(--good)' : 'var(--critical)'} /> {LAST_DELIVERY[last.kind]?.(formatAgoIso(last.at, now)) ?? t('last {kind} {time}', { kind: last.kind, time: formatAgoIso(last.at, now) })}
                {last.ok ? '' : ` (${t('failed: {error}', { error: last.error })})`}
              </span>
            </>
          )}
        </div>
      </div>
      <button type="button" className="btn-ghost row-action" onClick={() => test.mutate()} disabled={test.isPending}>
        {test.isPending ? t('Sending…') : t('Test')}
      </button>
      <Menu
        label={t('More for {name}', { name: c.name })}
        items={[
          { label: t('Edit'), icon: 'edit', onSelect: onEdit },
          { label: t('Delete'), icon: 'trash', danger: true, onSelect: () => del.mutate() },
        ]}
      />
    </li>
  );
}

function Heartbeat() {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: qkNotify, queryFn: ({ signal }) => api.notifySettings(signal) });
  const [url, setUrl] = useState<string | null>(null);
  const [minutes, setMinutes] = useState<string | null>(null);
  const save = useMutation({
    // url null: keep the saved URL (it is write-only); "" removes it.
    mutationFn: (opts?: { clear?: boolean }) =>
      api.saveNotifySettings({
        ...(opts?.clear ? { heartbeat_url: '' } : url !== null ? { heartbeat_url: url.trim() } : {}),
        heartbeat_minutes: Number(minutes ?? s.data?.heartbeat_minutes ?? 5),
      }),
    onSuccess: (d) => {
      qc.setQueryData(qkNotify, d);
      setUrl(null);
      setMinutes(null);
      toast(t('Heartbeat saved.'), 'success');
    },
    onError: (err) => toast(errorText(err), 'error'),
  });
  const now = useNow();
  return (
    <section className="card settings-card" aria-labelledby="hb-title">
      <h2 className="h2" id="hb-title">
        {t('Hub heartbeat')}
      </h2>
      <p className="ink-2">{t('Rackoon calls this URL on a schedule, so an outside monitor (Healthchecks, Uptime Kuma push) notices when the hub itself stops.')}</p>
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <TextField
          label="URL"
          mono
          placeholder={s.data?.heartbeat_set ? t('{target} (saved; type to replace)', { target: s.data.heartbeat_target }) : 'https://hc-ping.com/…'}
          value={url ?? ''}
          onChange={(e) => setUrl(e.target.value)}
          autoComplete="off"
        />
        <TextField label={t('Every (minutes)')} type="number" min="1" max="60" value={minutes ?? String(s.data?.heartbeat_minutes ?? 5)} onChange={(e) => setMinutes(e.target.value)} />
        {s.data?.heartbeat_set && (
          <div className="lbl">
            <Dot color={s.data.heartbeat_failing ? 'var(--critical)' : 'var(--good)'} />{' '}
            {s.data.heartbeat_failing ? t('The last ping failed (see the deliveries).') : s.data.heartbeat_last ? t('Last ping {time}', { time: formatAgoIso(s.data.heartbeat_last, now) }) : t('Not pinged yet.')}
          </div>
        )}
        <div className="form-actions">
          <button type="submit" className="btn-primary" disabled={save.isPending || (url === null && minutes === null)}>
            {t('Save')}
          </button>
          {s.data?.heartbeat_set && (
            <button type="button" className="btn-ghost" disabled={save.isPending} onClick={() => save.mutate({ clear: true })}>
              {t('Remove')}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function Deliveries({ names }: { names: Record<string, string> }) {
  const d = useQuery({ queryKey: qkDeliveries, queryFn: ({ signal }) => api.deliveries(signal), refetchInterval: 15_000 });
  const now = useNow();
  return (
    <section className="card list-card" aria-labelledby="deliveries-title">
      <div className="list-card-head">
        <h2 className="h2" id="deliveries-title">
          {t('Recent deliveries')}
        </h2>
        <span className="lbl">{t('Kept 30 days')}</span>
      </div>
      {d.isError && !d.data ? (
        <InlineRetry title={t('Could not load the deliveries')} error={d.error} onRetry={() => void d.refetch()} />
      ) : !d.data ? (
        <Skeleton height={80} />
      ) : d.data.length === 0 ? (
        <div className="alert-empty">{t('Nothing sent yet.')}</div>
      ) : (
        <ul className="plain-list">
          {d.data.map((x) => (
            <li key={x.id} className="dl-row">
              <Dot color={x.ok ? 'var(--good)' : 'var(--critical)'} />
              <span className="dl-what">
                <span className="strong">{names[x.channel] ?? (x.channel === 'heartbeat' ? t('Heartbeat') : x.channel)}</span> · {x.summary}
                {x.attempt > 1 ? ` (${t('attempt {n}', { n: x.attempt })})` : ''}
                {!x.ok && <span className="dl-err"> · {x.error}</span>}
              </span>
              <time className="lbl" dateTime={x.at} title={formatFull(Date.parse(x.at))}>
                {formatAgoIso(x.at, now)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function NotificationsPage() {
  useTitle(t('Notifications'));
  const channels = useQuery({ queryKey: qkChannels, queryFn: ({ signal }) => api.channels(signal), refetchInterval: 30_000 });
  const [editing, setEditing] = useState<Channel | null | 'new'>(null);
  const names: Record<string, string> = {};
  for (const c of channels.data ?? []) names[c.id] = c.name;
  return (
    <RequireAdmin title={t('Notifications')} text={t('Only admins manage where alerts are sent.')}>
      <header className="page-head">
        <div>
          <h1 className="page-title">{t('Notifications')}</h1>
          <p className="page-sub">
            {t('Alerts are sent once they have needed attention for 30 seconds; acknowledged and muted ones are not.')}
            {channels.data ? ` ${plural(channels.data.length, 'channel')}.` : ''}
          </p>
        </div>
        <div className="page-controls">
          <button type="button" className="btn-ghost" onClick={() => setEditing('new')}>
            <Icon name="plus" size={15} />
            {t('New channel')}
          </button>
        </div>
      </header>
      <section className="card list-card" aria-labelledby="channels-title">
        <div className="list-card-head">
          <h2 className="h2" id="channels-title">
            {t('Channels')}
          </h2>
        </div>
        {channels.isError && !channels.data ? (
          <InlineRetry title={t('Could not load the channels')} error={channels.error} onRetry={() => void channels.refetch()} />
        ) : !channels.data ? (
          <Skeleton height={80} />
        ) : channels.data.length === 0 ? (
          <div className="alert-empty">{t('No channels yet. Add ntfy for phone pushes, a webhook, or any service Shoutrrr supports (Discord, Telegram, email, Gotify, Pushover, Slack, Matrix…).')}</div>
        ) : (
          <ul className="plain-list">
            {channels.data.map((c) => (
              <ChannelRow key={c.id} c={c} onEdit={() => setEditing(c)} />
            ))}
          </ul>
        )}
      </section>
      <Deliveries names={names} />
      <Heartbeat />
      {editing !== null && <ChannelDialog channel={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </RequireAdmin>
  );
}
