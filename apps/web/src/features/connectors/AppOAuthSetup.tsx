/**
 * The OAuth app of an `app_oauth` catalog entry (Dropbox; connections-catalog.md CX-14; app AP-762), guided like
 * Google's (CN-03): create the app in the provider's console, give it the permissions before you sign in, add the redirect URI (with a copy button) — on Dropbox leave public clients allowed and enable additional
 * users, or only the app's owner can connect (Whombat connection-signin.md SG-22; AP-3910) — paste the app key and —
 * where the provider wants one — the secret. Saved, it says so with Replace and Remove; an app set in the config is
 * read-only (CT-1553). The Google page's numbered steps and copy rows.
 */
import {
  APP_SETUP_TEXT,
  type AppMethod,
  appSaveProblem,
  appSummary,
  appWords,
} from '@whombat/client/connections';
import { useConnectorAppWrite } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import type { CatalogAppStatus, CatalogEntry } from '@whombat/core/domain';
import { formatAgo } from '@whombat/core/text';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { Input } from '../../components/Input';
import { SectionLabel } from '../../components/SectionLabel';
import { type DotTone, StatusDot } from '../../components/StatusDot';
import { useToast } from '../../components/Toast';
import styles from '../settings/SettingsScreen.module.css';
import { ExternalLink } from './CatalogParts';
import c from './Connectors.module.css';
import { connectProblem } from './catalog';

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function AppOAuthSetup({
  entry,
  method,
  app,
}: {
  entry: CatalogEntry;
  method: AppMethod;
  app: CatalogAppStatus;
}) {
  const words = appWords(entry);
  const done = app.configured;
  const [showSteps, setShowSteps] = useState(!done);
  const stepsId = useId();
  const summary = appSummary(entry, app);
  return (
    <section className={styles.section}>
      <SectionLabel as="h2">{APP_SETUP_TEXT.section(entry.name)}</SectionLabel>
      <div className={styles.card}>
        <div className={styles.row}>
          <StatusDot
            tone={done ? 'ok' : 'mut'}
            size={8}
            label={done ? APP_SETUP_TEXT.setUp : APP_SETUP_TEXT.notSetUp}
          />
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>{APP_SETUP_TEXT.forThisWhombat}</span>
            <span className={styles.rowMeta}>{summary}</span>
          </span>
          {done && app.source !== 'config' && (
            <Button
              variant="ghost"
              size="sm"
              className={c.toggleSteps}
              aria-expanded={showSteps}
              aria-controls={stepsId}
              onClick={() => setShowSteps((v) => !v)}
            >
              {showSteps ? APP_SETUP_TEXT.hideSteps : APP_SETUP_TEXT.showSteps}
            </Button>
          )}
        </div>
        {app.source !== 'config' && (showSteps || !done) && (
          <ol id={stepsId} className={c.steps} aria-label={`Set up ${entry.name}`}>
            <Step n={1} title={APP_SETUP_TEXT.stepCreate} done={done}>
              {entry.id === 'dropbox' ? (
                <p className={c.stepText}>
                  In {words.console}, create an app with <strong>Scoped access</strong> and{' '}
                  <strong>Full Dropbox</strong> (or App folder, to keep agents to one folder). Name it after
                  this Whombat.
                </p>
              ) : (
                <p className={c.stepText}>
                  In {words.console}, create an OAuth app for this Whombat. Name it after this Whombat.
                </p>
              )}
              <ExternalLink href={method.consoleUrl}>
                {APP_SETUP_TEXT.openConsole(words.console)}
              </ExternalLink>
            </Step>
            <Step n={2} title={APP_SETUP_TEXT.stepPermissions} done={done}>
              <p className={c.stepText}>
                On the app’s Permissions tab, tick these and click <strong>Submit</strong> before anyone signs
                in:
              </p>
              <p className={c.stepText}>
                {method.scopes.map((s, i) => (
                  <span key={s}>
                    {i > 0 ? ' ' : null}
                    <span className={c.code}>{s}</span>
                  </span>
                ))}
              </p>
            </Step>
            <Step n={3} title={APP_SETUP_TEXT.stepRedirect} done={done}>
              <p className={c.stepText}>{APP_SETUP_TEXT.redirect}</p>
              <dl className={c.copyList}>
                <dt>{APP_SETUP_TEXT.redirectLabel}</dt>
                <dd>{app.redirectUri}</dd>
                <CopyButton
                  text={app.redirectUri}
                  copied={APP_SETUP_TEXT.redirectCopied}
                  className={c.copyButton}
                >
                  Copy<span className={c.srOnly}> redirect URI</span>
                </CopyButton>
              </dl>
              {entry.id === 'dropbox' && (
                <>
                  <p className={c.stepText}>
                    Leave <strong>Allow public clients (Implicit Grant &amp; PKCE)</strong> on Allow.
                  </p>
                  <p className={c.stepText}>
                    Under Development users, click <strong>Enable additional users</strong>, so people other
                    than you can connect.
                  </p>
                </>
              )}
            </Step>
            <Step n={4} title={APP_SETUP_TEXT.stepPaste(words.id)} done={done}>
              <AppForm entry={entry} method={method} app={app} />
            </Step>
          </ol>
        )}
      </div>
    </section>
  );
}

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children: ReactNode;
}) {
  const tone: DotTone = done ? 'ok' : 'mut';
  return (
    <li className={c.step}>
      <span className={c.stepMark}>
        <span className={c.stepNumber} data-done={done || undefined} aria-hidden="true">
          {n}
        </span>
      </span>
      <div className={c.stepMain}>
        <h3 className={c.stepTitle}>
          <span className={c.srOnly}>Step {n}: </span>
          {title}
          <StatusDot tone={tone} size={7} label={done ? 'Done' : 'To do'} />
        </h3>
        {children}
      </div>
    </li>
  );
}

function AppForm({ entry, method, app }: { entry: CatalogEntry; method: AppMethod; app: CatalogAppStatus }) {
  const toast = useToast();
  const ids = useId();
  const words = appWords(entry);
  const save = useConnectorAppWrite(api.connectors.setApp);
  const remove = useConnectorAppWrite(api.connectors.removeApp);
  const [editing, setEditing] = useState(!app.configured);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    const id = clientId.trim();
    const key = secret.trim();
    const refused = appSaveProblem(entry, method, app, { clientId, secret });
    if (refused === 'unchanged') {
      setEditing(false);
      return;
    }
    if (refused) {
      setError(refused);
      return;
    }
    setError(null);
    try {
      const result = await save.mutateAsync({
        params: { catalogId: entry.id },
        body: { ...(id ? { clientId: id } : {}), ...(key ? { clientSecret: key } : {}) },
      });
      if (result.status === 'ok') {
        setClientId('');
        setSecret('');
        setEditing(false);
        toast.show(APP_SETUP_TEXT.saved(entry.name));
      }
    } catch (err) {
      const p = connectProblem(err);
      setError(p.fields.clientId ?? p.fields.clientSecret ?? p.message);
    }
  }

  async function onRemove() {
    try {
      const result = await remove.mutateAsync({ params: { catalogId: entry.id } });
      setConfirmRemove(false);
      if (result.status === 'ok') toast.show(APP_SETUP_TEXT.removed(entry.name));
    } catch (err) {
      setError(connectProblem(err).message);
    }
  }

  if (!editing)
    return (
      <>
        <p className={c.stepText}>
          Saved · {words.id} <span className={c.code}>{app.clientIdHint}</span>
          {app.secretSet ? ` · ${words.secret.toLowerCase()} saved` : ''}
          {app.updatedAt ? ` · ${formatAgo(app.updatedAt, new Date(), LOCAL_TZ)}` : ''}
        </p>
        {confirmRemove ? (
          <div className={c.formActions}>
            <span className={c.hint}>{APP_SETUP_TEXT.confirmRemove(entry.name)}</span>
            <Button variant="secondary" size="sm" onClick={() => void onRemove()} disabled={remove.isPending}>
              {APP_SETUP_TEXT.removeApp}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
              {APP_SETUP_TEXT.cancel}
            </Button>
          </div>
        ) : (
          <div className={c.formActions}>
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              {APP_SETUP_TEXT.replace}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(true)}>
              {APP_SETUP_TEXT.remove}
            </Button>
          </div>
        )}
        {error && (
          <p className={c.error} role="alert">
            {error}
          </p>
        )}
      </>
    );

  return (
    <form className={c.appForm} onSubmit={onSave} noValidate>
      <p className={c.stepText}>
        {APP_SETUP_TEXT.copyThem}
        {method.clientSecretOptional ? APP_SETUP_TEXT.optionalSecret(words.secret) : ''}
      </p>
      <div className={c.fields}>
        <label className={c.field} htmlFor={`${ids}-id`}>
          <span className={c.fieldLabel}>{words.id.toUpperCase()}</span>
          <Input
            id={`${ids}-id`}
            size="lg"
            spellCheck={false}
            autoComplete="off"
            placeholder={app.configured ? APP_SETUP_TEXT.keepId : 'a1b2c3d4e5f6g7h'}
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
              if (error) setError(null);
            }}
            invalid={error !== null}
          />
        </label>
        <label className={c.field} htmlFor={`${ids}-secret`}>
          <span className={c.fieldLabel}>
            {words.secret.toUpperCase()}
            {method.clientSecretOptional ? APP_SETUP_TEXT.optional : ''}
          </span>
          <Input
            id={`${ids}-secret`}
            size="lg"
            type="password"
            spellCheck={false}
            autoComplete="new-password"
            placeholder={app.secretSet ? APP_SETUP_TEXT.keepSecret : ''}
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value);
              if (error) setError(null);
            }}
            invalid={error !== null}
          />
        </label>
      </div>
      {error && (
        <p className={c.error} role="alert">
          {error}
        </p>
      )}
      <div className={c.formActions}>
        <Button type="submit" variant="primary" size="md" disabled={save.isPending}>
          {APP_SETUP_TEXT.save}
        </Button>
        {app.configured && (
          <Button
            variant="ghost"
            size="md"
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
