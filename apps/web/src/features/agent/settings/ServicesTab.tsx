/**
 * Settings → Agent → **Running** (Whombat one-person.md OP-19; contracts 3.0 CT-1533…CT-1537; one-person.md AP-5690):
 * what the agent keeps running on the person's Whombat as containers — each one's name, its state and since when, its
 * link while it runs, and **Stop** (it asks first: the service stays stopped, also after a restart). Where this Whombat
 * has no container engine (development without Podman) it says so (`services.list`'s `reason`, `SERVICES_NOT_HERE`).
 * It replaced the agent's Computer tab. Not in the mocks: the settings page's rows.
 */
import { ApiError } from '@whombat/client';
import { useAgentServices, useStopService } from '@whombat/client/react';
import { type AgentService, SERVICES_NOT_HERE } from '@whombat/core/contracts';
import { useState } from 'react';
import { LoadErrorNote } from '../../../app/runtime';
import { Button } from '../../../components/Button';
import { SkeletonRows } from '../../../components/ListState';
import { Modal, ModalDescription, ModalTitle } from '../../../components/Modal';
import { SectionLabel } from '../../../components/SectionLabel';
import { StatusDot } from '../../../components/StatusDot';
import { useToast } from '../../../components/Toast';
import { useBurrowViewer } from '../../runs/useBurrowViewer';
import type { SettingsTabProps } from './AgentTab';
import settings from './AgentTab.module.css';
import styles from './Services.module.css';
import {
  SERVICE_STATE_LABELS,
  SERVICE_STATE_TONES,
  serviceLine,
  serviceLink,
  serviceStoppable,
  SERVICES_TEXT as T,
} from './services';

export function ServicesTab({ burrow, profile }: SettingsTabProps) {
  const agent = profile.agent.name;
  const viewer = useBurrowViewer(burrow);
  const toast = useToast();
  const { data, error, refetch } = useAgentServices({ params: { burrow } });
  const stop = useStopService(burrow);
  const [confirming, setConfirming] = useState<AgentService | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function stopIt(service: AgentService) {
    setProblem(null);
    try {
      const result = await stop.mutateAsync({ id: service.id });
      if (result.status !== 'ok') {
        setProblem(result.status === 'blocked' ? result.message : T.failed);
        return;
      }
      setConfirming(null);
      toast.show(T.stopped(service.name));
    } catch (e) {
      setProblem(e instanceof ApiError && e.message ? e.message : T.failed);
    }
  }

  const now = Date.now();
  return (
    <>
      <p className={styles.intro}>{T.intro(agent)}</p>
      <div className={settings.group} data-services="">
        <SectionLabel>{T.title}</SectionLabel>
        {!data ? (
          error ? (
            <LoadErrorNote error={error} message={T.loadFailed} onRetry={() => void refetch()} />
          ) : (
            <SkeletonRows count={2} lines={1} />
          )
        ) : !data.available ? (
          <p className={styles.reason} data-services-here="no">
            {data.reason ?? SERVICES_NOT_HERE}
          </p>
        ) : data.services.length === 0 ? (
          <p className={settings.hint}>{T.empty(agent)}</p>
        ) : (
          <ul className={styles.rows} aria-label={T.title}>
            {data.services.map((s) => {
              const link = serviceLink(s);
              return (
                <li key={s.id} className={styles.row} data-service={s.name} data-service-state={s.state}>
                  <span className={styles.rowMain}>
                    <span className={styles.name}>
                      <StatusDot
                        tone={SERVICE_STATE_TONES[s.state]}
                        size={8}
                        label={SERVICE_STATE_LABELS[s.state]}
                      />
                      {s.name}
                    </span>
                    <span className={styles.rowLine}>{serviceLine(s, now, viewer.timeZone)}</span>
                    {link && (
                      <a className={styles.link} href={link} target="_blank" rel="noreferrer">
                        {link}
                      </a>
                    )}
                  </span>
                  {serviceStoppable(s) && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={stop.isPending}
                      aria-label={T.stopLabel(s.name)}
                      onClick={() => {
                        setProblem(null);
                        setConfirming(s);
                      }}
                    >
                      {T.stop}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {problem && !confirming && (
          <p className={settings.error} role="alert">
            {problem}
          </p>
        )}
      </div>
      <Modal open={confirming !== null} onOpenChange={(open) => (open ? null : setConfirming(null))}>
        <ModalTitle className={settings.confirmTitle}>
          {confirming ? T.stopTitle(confirming.name) : ''}
        </ModalTitle>
        <ModalDescription className={settings.confirmText}>{T.stopBody(agent)}</ModalDescription>
        {problem && (
          <p className={settings.error} role="alert">
            {problem}
          </p>
        )}
        <div className={settings.confirmActions}>
          <Button variant="secondary" size="xl" onClick={() => setConfirming(null)}>
            {T.cancel}
          </Button>
          <Button
            variant="primary"
            size="xl"
            className={styles.dangerPrimary}
            disabled={stop.isPending}
            onClick={() => (confirming ? void stopIt(confirming) : undefined)}
          >
            {T.stop}
          </Button>
        </div>
      </Modal>
    </>
  );
}
