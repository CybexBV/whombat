/**
 * The 1Password connection's own part (Whombat onepassword-sync.md OPW-24, OPW-26, OPW-50; app onepassword-sync.md): on
 * its page, instead of the agent's level, handle, last use and tools (the agent never uses it), KEPT IN STEP — the
 * vault's name, how many entries are kept in step, the waiting, failing or read-only line, “1Password says 4 items are
 * gone” with their names and the two answers, “Not in your Vault” with each item's reason, and the last check with
 * Sync now. It reads what the last pass stored (`connections.onePassword`), and reads again every few seconds while a
 * pass runs. Not in the mocks: the connection page's blocks, rows and footer (ConnectionPage, GatewayParts).
 */
import {
  ONEPASSWORD_APP_TEXT,
  onePasswordAnsweredText,
  onePasswordPage,
  onePasswordSetChanged,
} from '@whombat/client';
import { useOnePassword, useOnePasswordWrite } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import type { ConnectionView } from '@whombat/core/domain';
import { ONEPASSWORD_WORDS, type OnePasswordRemovalAnswer } from '@whombat/core/vault';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { ErrorNote, SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { useToast } from '../../components/Toast';
import styles from '../settings/SettingsScreen.module.css';
import c from './Connectors.module.css';
import { connectProblem } from './catalog';

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** How often the page reads again while a pass runs: the pass's end sends nothing when it changed nothing. */
const SYNCING_POLL_MS = 3000;

export function OnePasswordSection({ burrow, conn }: { burrow: string; conn: Pick<ConnectionView, 'id'> }) {
  const toast = useToast();
  const params = { burrow, connectionId: conn.id };
  const query = useOnePassword(
    { params },
    { retry: false, refetchInterval: (q) => (q.state.data?.syncing ? SYNCING_POLL_MS : false) },
  );
  const sync = useOnePasswordWrite(api.connections.onePasswordSync, burrow);
  const answer = useOnePasswordWrite(api.connections.onePasswordRemovals, burrow);
  const [problem, setProblem] = useState<string | null>(null);
  const view = query.data;

  const head = (
    <SectionLabel as="h2" id="connection-onepassword">
      {ONEPASSWORD_APP_TEXT.section}
    </SectionLabel>
  );
  if (!view)
    return (
      <section className={styles.section} aria-labelledby="connection-onepassword">
        {head}
        {query.error ? (
          <ErrorNote message={ONEPASSWORD_APP_TEXT.failed} onRetry={() => void query.refetch()} />
        ) : (
          <div className={styles.card}>
            <SkeletonRows count={2} lines={2} />
          </div>
        )}
      </section>
    );

  const page = onePasswordPage(view, new Date(), LOCAL_TZ);

  async function syncNow() {
    setProblem(null);
    try {
      await sync.mutateAsync({ params, body: {} });
    } catch (err) {
      setProblem(connectProblem(err).message);
    }
  }

  async function answerRemovals(choice: OnePasswordRemovalAnswer, token: string) {
    setProblem(null);
    try {
      const result = await answer.mutateAsync({ params, body: { answer: choice, token } });
      if (result.status === 'ok') toast.show(onePasswordAnsweredText(choice));
      else if (result.status === 'blocked') setProblem(result.message);
    } catch (err) {
      // The set changed since it was shown: the page reads it again, nothing was removed.
      setProblem(onePasswordSetChanged(err) ? ONEPASSWORD_APP_TEXT.changed : connectProblem(err).message);
    }
  }

  return (
    <section className={styles.section} aria-labelledby="connection-onepassword" data-onepassword="">
      {head}
      <div className={styles.card}>
        <div className={c.block}>
          <span className={c.main}>
            <span className={c.fieldLabel}>{ONEPASSWORD_APP_TEXT.vaultLabel}</span>
            <span className={c.name}>{page.vault}</span>
            <span className={c.meta}>{page.kept}</span>
            {page.status.map((line) => (
              <span key={line.text} className={c.meta} data-tone={line.tone} data-status="">
                {line.text}
              </span>
            ))}
          </span>
        </div>
        {page.removals && (
          <div className={c.block} data-block="removals">
            <span className={c.main}>
              <span className={c.name}>{page.removals.title}</span>
            </span>
            <ul className={c.checks} aria-label={page.removals.title}>
              {page.removals.names.map((name, i) => (
                // Two entries may share a name.
                // biome-ignore lint/suspicious/noArrayIndexKey: the names are the list, in the server's order
                <li key={`${i}-${name}`} className={c.check}>
                  <span className={c.checkName}>{name}</span>
                </li>
              ))}
            </ul>
            <div className={c.formActions}>
              <Button
                variant="secondary"
                size="sm"
                disabled={answer.isPending}
                onClick={() => page.removals && void answerRemovals('remove', page.removals.token)}
              >
                {ONEPASSWORD_WORDS.removeHere}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={answer.isPending}
                onClick={() => page.removals && void answerRemovals('keep', page.removals.token)}
              >
                {ONEPASSWORD_WORDS.keepHere}
              </Button>
            </div>
          </div>
        )}
        {page.notInVault.length > 0 && (
          <div className={c.block} data-block="not-in-vault">
            <span className={c.fieldLabel}>{ONEPASSWORD_WORDS.notInVault.toUpperCase()}</span>
            <ul className={c.checks} aria-label={ONEPASSWORD_WORDS.notInVault}>
              {page.notInVault.map((item) => (
                <li key={item.id} className={c.check}>
                  <span className={c.checkName}>{item.title}</span>
                  <span className={c.checkState}>{item.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {problem && (
          <div className={c.block}>
            <p className={c.error} role="alert">
              {problem}
            </p>
          </div>
        )}
        <div className={c.footer}>
          <span className={c.meta} aria-live="polite">
            {page.checked}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page.syncing || sync.isPending}
            onClick={() => void syncNow()}
          >
            {ONEPASSWORD_WORDS.syncNow}
          </Button>
        </div>
      </div>
    </section>
  );
}
