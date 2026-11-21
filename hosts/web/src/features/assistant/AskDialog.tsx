// Starting investigations: "Ask assistant" (a question about one host, from
// its header; about the fleet, from the command palette) and the
// Investigate button of alert rows, which shows the alert's investigation
// once there is one. Admins only, while the assistant is on.

import { type FormEvent, useState } from 'react';
import { type Investigation, useAssistant, useAssistantEnabled, useInvestigations, useStartInvestigation } from '../../api/assist';
import type { Alert } from '../../api/types';
import { errorText, Field, InlineError } from '../../components/forms';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { toast } from '../../components/Toast';
import { t } from '../../lib/i18n';
import { ACCESS_LABEL, alertInvestigationLabel, investigationOfAlert, isActive, PROVIDER_NAME } from './labels';
import { askAssistant, useAskTarget, useOpenInvestigation } from './open';

/** The ask dialog, one per app (AppShell). */
export function AskDialogHost() {
  const target = useAskTarget();
  const enabled = useAssistantEnabled();
  if (!target || !enabled) return null;
  return <AskDialog server={target.server} onClose={() => askAssistant(null)} />;
}

function AskDialog({ server, onClose }: { server: string | null; onClose: () => void }) {
  const s = useAssistant();
  const start = useStartInvestigation();
  const open = useOpenInvestigation();
  const [text, setText] = useState('');
  const fallback = server ? t('Check this host’s health') : t('Check the health of all hosts');
  const settings = s.data?.settings;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (start.isPending) return;
    start.mutate(
      { ...(server ? { server } : {}), prompt: text.trim() || fallback },
      {
        onSuccess: (i) => {
          onClose();
          // Once the dialog has given the focus back to its opener, which the panel then returns it to.
          setTimeout(() => open(i.id), 0);
        },
      },
    );
  };
  return (
    <Modal
      open
      onClose={onClose}
      busy={start.isPending}
      title={server ? t('What should the assistant look into on {host}?', { host: server }) : t('What should the assistant look into?')}
      description={settings ? t('{provider} · {access}', { provider: PROVIDER_NAME[settings.provider], access: ACCESS_LABEL[settings.access] }) : undefined}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={start.isPending}>
            {t('Cancel')}
          </button>
          <button type="submit" form="ask-form" className="btn-primary" disabled={start.isPending}>
            <Icon name="sparkle" size={15} />
            {start.isPending ? t('Starting…') : t('Ask')}
          </button>
        </>
      }
    >
      <form id="ask-form" className="form-stack" onSubmit={submit}>
        <Field label={t('Question (optional)')} hint={t('Enter asks; Shift+Enter starts a new line.')}>
          {({ id, describedBy }) => (
            <textarea
              id={id}
              className="input inv-ask-input"
              aria-describedby={describedBy}
              autoFocus
              rows={3}
              maxLength={4000}
              value={text}
              placeholder={fallback}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          )}
        </Field>
        {start.isError && <InlineError>{errorText(start.error)}</InlineError>}
      </form>
    </Modal>
  );
}

/** Host header: "Ask assistant" about this host. */
export function AskAssistantButton({ server }: { server: string }) {
  const enabled = useAssistantEnabled();
  if (!enabled) return null;
  return (
    <button type="button" className="btn-ghost" onClick={() => askAssistant({ server })}>
      <Icon name="sparkle" size={15} />
      {t('Ask assistant')}
    </button>
  );
}

/** Alert rows: Investigate, or the state of the alert's investigation (opens it). */
export function InvestigateButton({ alert, className = 'btn-ghost row-action' }: { alert: Alert; className?: string }) {
  const enabled = useAssistantEnabled();
  const list = useInvestigations({ limit: 100 }, enabled);
  const start = useStartInvestigation();
  const open = useOpenInvestigation();
  if (!enabled || !list.data) return null;
  const found: Investigation | undefined = investigationOfAlert(list.data, alert.id);
  if (found) {
    const label = alertInvestigationLabel(found.state);
    const working = found.state === 'starting' || found.state === 'running';
    return (
      <button
        type="button"
        className={`${className} inv-alert-btn${found.state === 'waiting' ? ' is-waiting' : ''}`}
        aria-label={t('{state}: open the investigation of {title}', { state: label, title: alert.title })}
        onClick={() => open(found.id)}
      >
        {working ? <span className="spinner spinner-sm" aria-hidden="true" /> : <Icon name={isActive(found.state) ? 'warning' : 'sparkle'} size={14} />}
        {label}
      </button>
    );
  }
  if (alert.state === 'resolved') return null;
  return (
    <button
      type="button"
      className={`${className} inv-alert-btn`}
      disabled={start.isPending}
      aria-label={t('Investigate {title}', { title: alert.title })}
      onClick={() =>
        start.mutate(
          { alert: alert.id },
          {
            onSuccess: (i) => open(i.id),
            onError: (err) => toast(t('Could not start the investigation: {error}', { error: errorText(err) }), 'error'),
          },
        )
      }
    >
      {start.isPending ? <span className="spinner spinner-sm" aria-hidden="true" /> : <Icon name="sparkle" size={14} />}
      {t('Investigate')}
    </button>
  );
}
