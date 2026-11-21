import { problemText, withBurrow } from '@whombat/client';
import { holdGoogleConnect } from '@whombat/client/managed';
import {
  useCheckConnection,
  useRemoveConnection,
  useRemoveMicrosoftApp,
  useSetMicrosoftApp,
  useStartMicrosoftConnection,
} from '@whombat/client/react';
import {
  type ConnectorService,
  type ConnectorsStatus,
  MICROSOFT_SERVICES,
  serviceLabel,
} from '@whombat/core';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useManaged } from '../../app/providers';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { SectionLabel } from '../../components/SectionLabel';
import { useToast } from '../../components/Toast';
import type { ConnectOutcome } from '../settings/ConnectionsTab';
import styles from '../settings/SettingsScreen.module.css';
import { AccountKeys } from './AccountKeys';
import c from './Connectors.module.css';
import { connectErrorText } from './copy';

export function MicrosoftConnection({
  burrow,
  status,
  outcome,
  onOutcomeSeen,
  navigate = (url) => window.location.assign(url),
}: {
  burrow: string;
  status: ConnectorsStatus;
  outcome?: ConnectOutcome;
  onOutcomeSeen?: () => void;
  navigate?: (url: string) => void;
}) {
  const ids = useId();
  const managed = useManaged();
  const toast = useToast();
  const seen = useRef(false);
  const save = useSetMicrosoftApp();
  const removeApp = useRemoveMicrosoftApp();
  const start = useStartMicrosoftConnection();
  const check = useCheckConnection();
  const disconnect = useRemoveConnection();
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [picked, setPicked] = useState<ConnectorService[]>([...MICROSOFT_SERVICES]);
  const [problem, setProblem] = useState<string | null>(null);
  const microsoft = status.microsoft;
  const connection = status.connections.find((item) => item.provider === 'microsoft');
  const busy =
    save.isPending || removeApp.isPending || start.isPending || check.isPending || disconnect.isPending;
  const report = (e: unknown) => setProblem(problemText(e));
  useEffect(() => {
    if (seen.current || (!outcome?.connected && !outcome?.connectError)) return;
    seen.current = true;
    if (outcome.connectError)
      setProblem(connectErrorText(outcome.connectError).replaceAll('Google', 'Microsoft'));
    else toast.show(connection ? `Microsoft connected: ${connection.email}.` : 'Microsoft connected.');
    onOutcomeSeen?.();
  }, [outcome, onOutcomeSeen, toast, connection]);
  function requireOk(result: { status: string }) {
    if (result.status !== 'ok')
      throw new Error('The change was not applied. Check your permissions and try again.');
  }
  async function onSave(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    try {
      const result = await save.mutateAsync({
        body: {
          ...(clientId ? { clientId } : {}),
          ...(secret ? { clientSecret: secret } : {}),
          userType: 'external',
        },
      });
      requireOk(result);
      setSecret('');
      setClientId('');
    } catch (error) {
      report(error);
    }
  }
  async function connect() {
    setProblem(null);
    const returnTo = withBurrow('/settings?tab=connections&connection=microsoft', burrow);
    if (managed && !holdGoogleConnect(() => sessionStorage, { device: managed.applianceId, returnTo }))
      return setProblem('This browser could not save where to return. Enable session storage and try again.');
    try {
      const result = await start.mutateAsync({ body: { services: picked, returnTo } });
      if (result.status === 'ok') navigate(result.data.authorizeUrl);
      else requireOk(result);
    } catch (error) {
      report(error);
    }
  }
  if (!microsoft) return <p className={c.intro}>Update this Whombat to connect Microsoft 365.</p>;
  return (
    <>
      {problem && (
        <p role="alert" className={c.intro}>
          {problem}
        </p>
      )}
      {microsoft.app.source !== 'config' && (
        <section className={styles.section} aria-labelledby={`${ids}-app`}>
          <SectionLabel as="h2" id={`${ids}-app`}>
            MICROSOFT APP
          </SectionLabel>
          <div className={styles.card}>
            <div className={styles.row}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>
                  {microsoft.app.configured ? 'Application configured' : 'Set up Microsoft 365'}
                </span>
                <span className={styles.rowMeta}>
                  In Microsoft Entra → App registrations, register a Web application for organizational and
                  personal Microsoft accounts. Add this redirect URI and create a client secret.
                </span>
                <code>{microsoft.redirectUri}</code>
                <span className={styles.rowMeta}>
                  Delegated permissions: User.Read, Mail.ReadWrite, Mail.Send, Calendars.ReadWrite,
                  Files.ReadWrite and Contacts.Read. Each person chooses which services to connect; their
                  organization may require admin consent.
                </span>
              </span>
            </div>
            <form onSubmit={onSave}>
              <div className={styles.row}>
                <label className={styles.rowMain} htmlFor={`${ids}-client`}>
                  Application (client) ID
                  <Input
                    id={`${ids}-client`}
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder={microsoft.app.clientIdHint ?? ''}
                    autoComplete="off"
                  />
                </label>
              </div>
              <div className={styles.row}>
                <label className={styles.rowMain} htmlFor={`${ids}-secret`}>
                  Client secret value
                  <Input
                    id={`${ids}-secret`}
                    type="password"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    autoComplete="new-password"
                  />
                </label>
              </div>
              <div className={styles.row}>
                <Button type="submit" disabled={busy || (!clientId && !secret)}>
                  Save application
                </Button>
                {microsoft.app.configured && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void removeApp.mutateAsync({}).then(requireOk).catch(report)}
                  >
                    Remove application
                  </Button>
                )}
              </div>
            </form>
          </div>
        </section>
      )}
      <section className={styles.section} aria-labelledby={`${ids}-account`}>
        <SectionLabel as="h2" id={`${ids}-account`}>
          YOUR ACCOUNT
        </SectionLabel>
        <div className={styles.card}>
          {connection && (
            <div className={styles.row}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{connection.email}</span>
                <span className={styles.rowMeta}>
                  {connection.status === 'active' ? 'Connected' : 'Needs you to sign in again'}
                </span>
                {connection.checks.map((item) => (
                  <span className={styles.rowMeta} key={item.service}>
                    {serviceLabel(item.service, 'microsoft')}:{' '}
                    {item.state === 'ok' ? 'Ready' : (item.message ?? 'Needs attention')}
                  </span>
                ))}
              </span>
            </div>
          )}
          {MICROSOFT_SERVICES.map((service) => (
            <label className={styles.row} key={service}>
              <input
                type="checkbox"
                className={c.checkbox}
                checked={picked.includes(service)}
                onChange={(e) =>
                  setPicked((old) =>
                    e.target.checked ? [...old, service] : old.filter((s) => s !== service),
                  )
                }
              />
              {serviceLabel(service, 'microsoft')}
            </label>
          ))}
          <div className={styles.row}>
            <Button
              disabled={busy || !picked.length || !microsoft.app.configured}
              onClick={() => void connect()}
            >
              {connection ? 'Reconnect Microsoft 365' : 'Connect Microsoft 365'}
            </Button>
            {connection && (
              <>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void check
                      .mutateAsync({ params: { connectionId: connection.id } })
                      .then(requireOk)
                      .catch(report)
                  }
                >
                  Check again
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void disconnect
                      .mutateAsync({ params: { connectionId: connection.id } })
                      .then(requireOk)
                      .catch(report)
                  }
                >
                  Disconnect
                </Button>
              </>
            )}
          </div>
          <p className={styles.empty}>
            Disconnecting removes access from this Whombat. To revoke consent at Microsoft too, remove Whombat
            in your Microsoft account’s application permissions. Word and Excel files can be downloaded;
            native editing is not available.
          </p>
        </div>
      </section>
      {connection && <AccountKeys burrow={burrow} account="Microsoft 365" services={connection.services} />}
    </>
  );
}
