/**
 * HOME NETWORK: the networks and ports Vault entries and the assistant may reach on this Whombat's network while the
 * local network is closed to it, under that switch on What it may do (the Vault page links there). You add and remove
 * them, checked with core's `vaultNetworkProblem` before anything is sent.
 */

import type { UseQueryResult } from '@tanstack/react-query';
import { vaultProblemOf } from '@whombat/client';
import { useVaultNetworkWrite } from '@whombat/client/react';
import { api, type VaultNetworksResponse } from '@whombat/core/contracts';
import { formatAgo } from '@whombat/core/text';
import { canonicalCidr, VAULT_NETWORK_NOTE_MAX, vaultCopy, vaultNetworkProblem } from '@whombat/core/vault';
import { type FormEvent, useId, useState } from 'react';
import { useOpenBurrow } from '../../app/routing/openBurrow';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { useToast } from '../../components/Toast';
import { THIS_WHOMBAT_TEXT } from '../../i18n/clientWords';
import { useLocaleWords } from '../../i18n/words';
import { portsText, VAULT_TEXT } from './copy';
import { type FieldProblems, parsePorts } from './model';
import { useVaultWords } from './useVaultWords';
import styles from './Vault.module.css';

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function HomeNetwork({
  query,
  addBehindButton = false,
}: {
  query: UseQueryResult<VaultNetworksResponse, Error>;
  /** The add row behind “Add network” once the list has a network (What it may do). */
  addBehindButton?: boolean;
}) {
  const VAULT_COPY = useLocaleWords(vaultCopy);
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const remove = useVaultNetworkWrite(api.vaultNetworks.remove);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const headingId = useId();
  const words = useVaultWords(useOpenBurrow());
  const data = query.data;

  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <SectionLabel as="h2" id={headingId}>
        {VAULT_COPY.homeNetwork}
      </SectionLabel>
      <p className={styles.sectionIntro}>
        {/* One sentence (AP-1751): that the Vault and Connections share the list (CX-73, AP-761) shows in both. */}
        {words.homeNetworkIntro}
      </p>
      <div className={styles.card}>
        {query.error && !data ? (
          <p className={styles.empty}>
            {VAULT_TEXT.networksFailed}{' '}
            <Button variant="link" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </p>
        ) : !data ? (
          <SkeletonRows count={1} lines={2} />
        ) : (
          <>
            {data.networks.length === 0 ? (
              <p className={styles.empty}>{VAULT_COPY.noNetworks}</p>
            ) : (
              <ul className={styles.rows} aria-label={VAULT_COPY.homeNetwork}>
                {data.networks.map((n) => (
                  <li key={n.id} className={styles.networkRow}>
                    <span className={styles.main}>
                      <span className={styles.networkTitle}>
                        <span className={styles.mono}>{n.cidr}</span>
                        <span className={styles.meta}>{portsText(n.ports)}</span>
                      </span>
                      <span className={styles.meta}>
                        {[
                          n.note,
                          VAULT_TEXT.networkAddedBy(n.addedBy),
                          formatAgo(n.addedAt, Date.now(), LOCAL_TZ),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    {confirming === n.id ? (
                      <span className={styles.actions}>
                        <span className={styles.rowMeta}>{VAULT_TEXT.removeNetworkConfirm(n.cidr)}</span>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={remove.isPending}
                          onClick={async () => {
                            setProblem(null);
                            try {
                              const result = await remove.mutateAsync({ params: { networkId: n.id } });
                              if (result.status === 'ok') toast.show(VAULT_TEXT.networkRemoved(n.cidr));
                              setConfirming(null);
                            } catch (error) {
                              setProblem(vaultProblemOf(error).message ?? VAULT_TEXT.failed);
                            }
                          }}
                        >
                          Remove
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                          {VAULT_TEXT.cancel}
                        </Button>
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${n.cidr}`}
                        onClick={() => setConfirming(n.id)}
                      >
                        Remove
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {data.networks.length < data.max &&
              (!addBehindButton || adding || data.networks.length === 0 ? (
                <AddNetwork />
              ) : (
                <div className={styles.addRow}>
                  <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
                    {THIS_WHOMBAT_TEXT.addNetwork}
                  </Button>
                </div>
              ))}
          </>
        )}
      </div>
      {problem && (
        <p className={styles.error} role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

/** The form: a private range, its ports and a note (VT-12). */
function AddNetwork() {
  const toast = useToast();
  const add = useVaultNetworkWrite(api.vaultNetworks.add);
  const [cidr, setCidr] = useState('');
  const [ports, setPorts] = useState('');
  const [note, setNote] = useState('');
  const [problems, setProblems] = useState<FieldProblems>({});
  const [message, setMessage] = useState<string | null>(null);
  const ids = { cidr: useId(), ports: useId(), note: useId() };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const list = parsePorts(ports);
    const local: FieldProblems = {};
    if (!list) local.ports = VAULT_TEXT.portsProblem;
    else {
      const problem = vaultNetworkProblem(cidr.trim(), list);
      if (problem) local[problem.field] = problem.message;
    }
    setProblems(local);
    setMessage(null);
    if (Object.keys(local).length || !list) return;
    try {
      const result = await add.mutateAsync({ body: { cidr: cidr.trim(), ports: list, note: note.trim() } });
      if (result.status === 'ok') {
        toast.show(VAULT_TEXT.networkAdded(canonicalCidr(cidr.trim()) ?? cidr.trim()));
        setCidr('');
        setPorts('');
        setNote('');
      }
    } catch (error) {
      const p = vaultProblemOf(error);
      setProblems(p.fields);
      setMessage(p.message ?? (Object.keys(p.fields).length ? null : VAULT_TEXT.failed));
    }
  }

  return (
    <form className={styles.networkForm} onSubmit={(e) => void submit(e)} noValidate>
      <div className={styles.networkFields}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={ids.cidr}>
            {VAULT_TEXT.networkCidr}
          </label>
          <Input
            id={ids.cidr}
            className={styles.monoInput}
            spellCheck={false}
            placeholder={VAULT_TEXT.cidrPlaceholder}
            value={cidr}
            invalid={!!problems.cidr}
            aria-describedby={problems.cidr ? `${ids.cidr}-e` : undefined}
            onChange={(e) => setCidr(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={ids.ports}>
            {VAULT_TEXT.networkPorts}
          </label>
          <Input
            id={ids.ports}
            className={styles.monoInput}
            inputMode="numeric"
            placeholder={VAULT_TEXT.portsPlaceholder}
            value={ports}
            invalid={!!problems.ports}
            aria-describedby={problems.ports ? `${ids.ports}-e` : undefined}
            onChange={(e) => setPorts(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={ids.note}>
            {VAULT_TEXT.networkNote}
          </label>
          <Input
            id={ids.note}
            className={styles.input}
            maxLength={VAULT_NETWORK_NOTE_MAX}
            placeholder={VAULT_TEXT.notePlaceholder}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary" size="xl" disabled={add.isPending || !cidr.trim()}>
          {VAULT_TEXT.addNetwork}
        </Button>
      </div>
      {problems.cidr && (
        <p id={`${ids.cidr}-e`} className={styles.fieldError}>
          {problems.cidr}
        </p>
      )}
      {problems.ports && (
        <p id={`${ids.ports}-e`} className={styles.fieldError}>
          {problems.ports}
        </p>
      )}
      {message && (
        <p className={styles.error} role="alert">
          {message}
        </p>
      )}
    </form>
  );
}
