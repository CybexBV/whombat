// New / edit check (admins). The fields follow the kind; a heartbeat check
// has no target: after it is created the dialog shows its ping URL and how a
// cron job calls it.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api } from '../../api/client';
import { qk, useServers } from '../../api/queries';
import type { Check, CheckKind } from '../../api/types';
import { SegmentedControl } from '../../components/controls';
import { CopyBlock, errorText, InlineError, SelectField, Switch, TextField } from '../../components/forms';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { t } from '../../lib/i18n';
import {
  type CheckForm,
  DNS_TYPES,
  durationOptions,
  emptyForm,
  type FormErrors,
  formatSeconds,
  formOf,
  GRACES,
  INTERVALS,
  KINDS,
  PERIODS,
  pingExamples,
  toInput,
  validate,
} from './checkForm';

const PLACEHOLDER: Record<CheckKind, string> = {
  heartbeat: '',
  http: 'https://example.com/health',
  tcp: 'db.lan:5432',
  ping: '10.0.0.1',
  dns: 'example.com',
};

/** The ping URL of a heartbeat check and three lines for a cron job. */
export function PingHelp({ url }: { url: string }) {
  return (
    <div className="form-stack-sm">
      <span className="field-label">{t('Ping URL')}</span>
      <CopyBlock text={url} label={t('Ping URL')} />
      <span className="lbl">{t('Call it when the job succeeds. Add /start when it begins (Rackoon then times the run) and /fail or the exit code /$? to report a failure.')}</span>
      <div className="ping-examples">
        <CopyBlock text={pingExamples(url)} label={t('Examples for a cron job')} />
      </div>
    </div>
  );
}

export function CheckDialog({ check, onClose }: { check: Check | null; onClose: () => void }) {
  const qc = useQueryClient();
  const servers = useServers();
  const editing = check !== null;
  const [f, setF] = useState<CheckForm>(() => (check ? formOf(check) : emptyForm()));
  const [errors, setErrors] = useState<FormErrors>({});
  const [apiError, setApiError] = useState('');
  const [created, setCreated] = useState<Check | null>(null);
  const set = <K extends keyof CheckForm>(k: K, v: CheckForm[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const save = useMutation({
    mutationFn: () => (editing ? api.patchCheck(check.id, toInput(f)) : api.createCheck(toInput(f))),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: qk.checks });
      if (!editing && c.kind === 'heartbeat' && c.ping_url) {
        setCreated(c);
        return;
      }
      toast(editing ? t('Check saved.') : t('Check added. The first result comes within {time}.', { time: formatSeconds(c.interval_s) }), 'success');
      onClose();
    },
    onError: (err) => setApiError(errorText(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApiError('');
    const errs = validate(f);
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return;
    save.mutate();
  };

  if (created) {
    return (
      <Modal
        open
        wide
        onClose={onClose}
        title={t('{name} is waiting for its first ping', { name: created.name })}
        description={
          created.grace_s
            ? t('Rackoon raises an alert when no ping arrives for {period} plus {grace}.', { period: formatSeconds(created.interval_s), grace: formatSeconds(created.grace_s) })
            : t('Rackoon raises an alert when no ping arrives for {period}.', { period: formatSeconds(created.interval_s) })
        }
        actions={
          <button type="button" className="btn-primary" onClick={onClose}>
            {t('Done')}
          </button>
        }
      >
        <PingHelp url={created.ping_url!} />
      </Modal>
    );
  }

  const hb = f.kind === 'heartbeat';
  const tls = f.kind === 'http' || (f.kind === 'tcp' && f.tls);
  return (
    <Modal
      open
      wide
      onClose={onClose}
      busy={save.isPending}
      title={editing ? t('Edit {name}', { name: check.name }) : t('New check')}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" form="check-form" className="btn-primary" disabled={save.isPending}>
            {editing ? t('Save') : t('Add check')}
          </button>
        </>
      }
    >
      <form id="check-form" className="form-stack" onSubmit={submit} noValidate>
        {!editing && <SegmentedControl label={t('Kind')} options={KINDS} value={f.kind} onChange={(k) => set('kind', k)} />}
        <TextField label={t('Name')} value={f.name} maxLength={80} autoFocus placeholder={hb ? t('Nightly backup') : t('Website')} error={errors.name} onChange={(e) => set('name', e.target.value)} />
        {hb && (
          <div className="form-grid">
            <SelectField label={t('Expected every')} value={String(f.period_s)} error={errors.period_s} onChange={(e) => set('period_s', Number(e.target.value))}>
              {durationOptions(PERIODS, f.period_s).map((s) => (
                <option key={s} value={s}>
                  {formatSeconds(s)}
                </option>
              ))}
            </SelectField>
            <SelectField label={t('Grace time')} value={String(f.grace_s)} error={errors.grace_s} onChange={(e) => set('grace_s', Number(e.target.value))}>
              {durationOptions(GRACES, f.grace_s).map((s) => (
                <option key={s} value={s}>
                  {formatSeconds(s)}
                </option>
              ))}
            </SelectField>
          </div>
        )}
        {hb && editing && check.ping_url && <PingHelp url={check.ping_url} />}
        {!hb && (
          <>
            <TextField
              label={f.kind === 'http' ? 'URL' : f.kind === 'tcp' ? t('Host and port') : f.kind === 'dns' ? t('Name') : t('Host')}
              mono
              value={f.target}
              placeholder={PLACEHOLDER[f.kind]}
              autoComplete="off"
              spellCheck={false}
              error={errors.target}
              onChange={(e) => set('target', e.target.value)}
            />
            {f.kind === 'http' && (
              <div className="form-grid">
                <TextField
                  label={t('Expected status')}
                  mono
                  value={f.expect_status}
                  placeholder="200-399"
                  error={errors.expect_status}
                  onChange={(e) => set('expect_status', e.target.value)}
                />
                <TextField label={t('Keyword (optional)')} value={f.keyword} hint={t('Must appear in the page')} error={errors.keyword} onChange={(e) => set('keyword', e.target.value)} />
              </div>
            )}
            {f.kind === 'tcp' && <Switch checked={f.tls} onChange={(v) => set('tls', v)} label={t('TLS handshake')} description={t('Also checks the certificate')} />}
            {f.kind === 'dns' && (
              <div className="form-grid">
                <SelectField label={t('Record')} value={f.dns_type} onChange={(e) => set('dns_type', e.target.value)}>
                  {DNS_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </SelectField>
                <TextField label={t('Resolver (optional)')} mono value={f.dns_server} placeholder={t('System resolver')} error={errors.dns_server} onChange={(e) => set('dns_server', e.target.value)} />
                <TextField label={t('Expected answer (optional)')} value={f.expect} hint={t('Part of one record')} error={errors.expect} onChange={(e) => set('expect', e.target.value)} />
              </div>
            )}
            {tls && (
              <div className="form-grid">
                <TextField
                  label={t('Warn before the certificate expires')}
                  type="number"
                  min="0"
                  max="365"
                  value={f.cert_warn_days}
                  placeholder="14"
                  hint={t('Days')}
                  error={errors.cert_warn_days}
                  onChange={(e) => set('cert_warn_days', e.target.value)}
                />
                <Switch checked={f.insecure} onChange={(v) => set('insecure', v)} label={t('Accept any certificate')} description={t('Self-signed or expired: still up')} />
              </div>
            )}
            <div className="form-grid">
              <SelectField label={t('Run from')} value={f.runner} hint={t('An agent checks from its own network')} onChange={(e) => set('runner', e.target.value)}>
                <option value="hub">{t('Hub')}</option>
                {(servers.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id}
                  </option>
                ))}
                {f.runner !== 'hub' && !servers.data?.some((s) => s.id === f.runner) && <option value={f.runner}>{f.runner}</option>}
              </SelectField>
              <SelectField label={t('Every')} value={String(f.interval_s)} error={errors.interval_s} onChange={(e) => set('interval_s', Number(e.target.value))}>
                {durationOptions(INTERVALS, f.interval_s).map((s) => (
                  <option key={s} value={s}>
                    {formatSeconds(s)}
                  </option>
                ))}
              </SelectField>
            </div>
          </>
        )}
        {apiError && <InlineError>{apiError}</InlineError>}
      </form>
    </Modal>
  );
}
