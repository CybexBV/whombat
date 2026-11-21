// "Enroll a server" (CONTRACT 3): creates a single-use enrollment token on
// open, shows the install command with its expiry, waits for the agent's
// request (SSE `enrollment.pending` refetches the pending list; the list is
// also polled every 5 s) and approves it with a name and group in place.
// Rendered by the shell while `?enroll=1` is in the URL.

import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError } from '../../api/client';
import { usePendingEnrollments } from '../../api/queries';
import type { Enrollment, PendingEnrollment } from '../../api/types';
import { CopyBlock, errorText, InlineError } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { useNow } from '../../lib/clock';
import { formatClock, formatFull } from '../../lib/format';
import { t, tx } from '../../lib/i18n';
import { PRODUCT_NAME } from '../../lib/product';
import { agentSettingsPath } from '../../lib/urlState';
import { ApproveForm, PendingDetails } from './ApproveForm';

type Result = { kind: 'approved'; serverId: string; group: string } | { kind: 'rejected'; hostname: string };

/** "Expires in 59 min" / "Expires in 45 s". */
export function expiresIn(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.floor((expiresAt - now) / 1000));
  return s >= 60 ? t('Expires in {n} min', { n: Math.floor(s / 60) }) : t('Expires in {n} s', { n: s });
}

function createErrorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return t('Enrolling a server requires admin access.');
  return errorText(err);
}

export function EnrollModal({ initialName, onClose }: { initialName?: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const now = useNow();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [createError, setCreateError] = useState<unknown>(null);
  const [matched, setMatched] = useState<PendingEnrollment | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejectError, setRejectError] = useState('');

  const create = useCallback(async () => {
    setEnrollment(null);
    setCreateError(null);
    setMatched(null);
    setResult(null);
    setRejectError('');
    try {
      setEnrollment(await api.createEnrollment());
    } catch (err) {
      setCreateError(err);
    }
  }, []);

  // One token per opening (StrictMode runs effects twice; the ref survives).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void create();
  }, [create]);

  const waiting = !!enrollment && !matched && !result;
  const pendingList = usePendingEnrollments(waiting, true);
  useEffect(() => {
    if (!waiting || !enrollment) return;
    const p = pendingList.data?.find((x) => x.id === enrollment.id);
    if (p) setMatched(p);
  }, [waiting, enrollment, pendingList.data]);

  const expiresAt = enrollment ? Date.parse(enrollment.expires_at) : NaN;
  const expired = waiting && Number.isFinite(expiresAt) && now >= expiresAt;

  const reject = async () => {
    if (!matched || busy) return;
    setBusy(true);
    setRejectError('');
    try {
      await api.rejectEnrollment(matched.id);
      void qc.invalidateQueries({ queryKey: ['enrollments'] });
      setResult({ kind: 'rejected', hostname: matched.hostname ?? t('The host') });
    } catch (err) {
      setRejectError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const hostLabel = matched?.hostname ?? t('The agent');

  let status: string;
  let body: ReactNode;
  let actions: ReactNode = null;
  let description: ReactNode = undefined;

  if (createError) {
    status = t('Could not create an enrollment command.');
    body = <InlineError>{createErrorText(createError)}</InlineError>;
    actions = (
      <>
        <button type="button" className="btn-ghost" onClick={onClose}>
          {t('Close')}
        </button>
        {!(createError instanceof ApiError && createError.status === 403) && (
          <button type="button" className="btn-primary" onClick={() => void create()}>
            {t('Try again')}
          </button>
        )}
      </>
    );
  } else if (!enrollment) {
    status = t('Creating an enrollment command…');
    body = (
      <div className="enroll-status">
        <span className="spinner" aria-hidden="true" />
        <span>{t('Creating a one-time install command…')}</span>
      </div>
    );
  } else if (result?.kind === 'approved') {
    status = t('{server} was added to {group}.', { server: result.serverId, group: result.group });
    body = (
      <div className="enroll-done">
        <span className="enroll-done-icon" aria-hidden="true">
          <Icon name="check" size={20} />
        </span>
        <div>
          <p className="strong">{tx('{server} was added to {group}.', { server: <span className="mono">{result.serverId}</span>, group: result.group })}</p>
          <p className="ink-2">{t('Remote control is off until you turn it on in the server’s settings.')}</p>
        </div>
      </div>
    );
    actions = (
      <>
        <button type="button" className="btn-ghost" onClick={() => navigate(agentSettingsPath(result.serverId))}>
          {t('Server settings')}
        </button>
        <button type="button" className="btn-primary" onClick={onClose} autoFocus>
          {t('Done')}
        </button>
      </>
    );
  } else if (result?.kind === 'rejected') {
    status = t('The request from {host} was rejected.', { host: result.hostname });
    body = (
      <p className="ink-2">
        {tx('The request from {host} was rejected; the host was not added. To enroll it later, create a new command.', {
          host: <span className="mono ink">{result.hostname}</span>,
        })}
      </p>
    );
    actions = (
      <>
        <button type="button" className="btn-ghost" onClick={() => void create()}>
          {t('Create a new command')}
        </button>
        <button type="button" className="btn-primary" onClick={onClose} autoFocus>
          {t('Done')}
        </button>
      </>
    );
  } else if (matched) {
    status = t('{host} is asking to join.', { host: hostLabel });
    body = (
      <>
        <div className="enroll-status is-ready">
          <span className="enroll-ready-dot" aria-hidden="true" />
          <span>{tx('{host} is asking to join. Check the details, then approve it.', { host: <span className="mono strong">{hostLabel}</span> })}</span>
        </div>
        <PendingDetails p={matched} />
        {rejectError && <InlineError>{rejectError}</InlineError>}
        <ApproveForm
          pending={matched}
          initialName={initialName}
          autoFocusName
          onBusyChange={setBusy}
          onApproved={(serverId, group) => setResult({ kind: 'approved', serverId, group })}
          secondary={(approving) => (
            <button type="button" className="btn-ghost" onClick={() => void reject()} disabled={approving || busy}>
              {t('Reject')}
            </button>
          )}
        />
      </>
    );
  } else if (expired) {
    status = t('The install command expired.');
    body = (
      <InlineError>
        {t('This command expired at {time} before an agent used it. Create a new one; the old command no longer works.', { time: formatClock(expiresAt, now) })}
      </InlineError>
    );
    actions = (
      <>
        <button type="button" className="btn-ghost" onClick={onClose}>
          {t('Close')}
        </button>
        <button type="button" className="btn-primary" onClick={() => void create()}>
          {t('Create a new command')}
        </button>
      </>
    );
  } else {
    status = t('Waiting for the agent…');
    description = tx('Run this command as root on {host}. It installs the {product} agent, which then asks to join; you approve it here.', {
      host: initialName ? <span className="mono ink">{initialName}</span> : t('the new host'),
      product: PRODUCT_NAME,
    });
    body = (
      <>
        <CopyBlock text={enrollment.install_command} label={t('Install command')} />
        <div className="enroll-meta lbl">
          <Icon name="clock" size={15} />
          <time dateTime={enrollment.expires_at} title={t('Expires {time}', { time: formatFull(expiresAt) })}>
            {expiresIn(expiresAt, now)}
          </time>
          <span aria-hidden="true">·</span>
          <span>{t('Works once')}</span>
        </div>
        <div className="enroll-status">
          <span className="spinner" aria-hidden="true" />
          <span>{t('Waiting for the agent…')}</span>
        </div>
        <p className="lbl">
          {t('You can close this dialog at any time: the command stays valid until it expires, and the agent’s request then waits for approval in Settings › Agents.')}
        </p>
      </>
    );
    actions = (
      <button type="button" className="btn-ghost" onClick={onClose}>
        {t('Close')}
      </button>
    );
  }

  return (
    <Modal open onClose={onClose} title={t('Enroll a server')} description={description} wide busy={busy} actions={actions} className="enroll-modal">
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {status}
      </div>
      {body}
    </Modal>
  );
}
