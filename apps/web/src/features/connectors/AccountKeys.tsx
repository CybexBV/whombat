/**
 * WHAT {ASSISTANT} MAY DO on Google's and Microsoft 365's page (Whombat accounts.md): the keys to the person's own
 * account by service, each as a connection's tools are (Allowed · Asks · Off; sending, invites and sharing only Asks ·
 * Off). A change saves at once, every other key as it is.
 */
import {
  ACCOUNT_TIER_LABELS,
  type AccountKeyRow,
  accountKeyGroups,
  accountKeysText,
  withAccountTier,
} from '@whombat/client/connections';
import { useAgent, useSetAgentKeys, useTheAgent } from '@whombat/client/react';
import type { ConnectorService } from '@whombat/core';
import type { KeyId, Tier } from '@whombat/core/keys';
import { useId, useState } from 'react';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useToast } from '../../components/Toast';
import styles from '../settings/SettingsScreen.module.css';
import k from './Catalog.module.css';
import c from './Connectors.module.css';

export function AccountKeys({
  burrow,
  account,
  services,
}: {
  burrow: string;
  /** “Google”, “Microsoft 365”. */
  account: string;
  services: readonly ConnectorService[];
}) {
  const { words } = useTheAgent(burrow);
  const { data: profile } = useAgent({ params: { burrow } }, { retry: false });
  const setKeys = useSetAgentKeys(burrow);
  const toast = useToast();
  const [problem, setProblem] = useState<string | null>(null);
  const titleId = useId();
  if (!profile) return null;
  const t = accountKeysText(words.name);
  const groups = accountKeyGroups(profile.grants, services, words.name);
  if (groups.length === 0) return null;

  async function change(keyId: KeyId, tier: Tier) {
    if (!profile) return;
    setProblem(null);
    try {
      const result = await setKeys.mutateAsync({
        params: { burrow },
        body: { grants: withAccountTier(profile.grants, keyId, tier) },
      });
      if (result.status === 'ok') toast.show(t.saved);
      else setProblem(result.status === 'blocked' ? result.message : t.failed);
    } catch {
      setProblem(t.failed);
    }
  }

  return (
    <section className={styles.section} aria-labelledby={titleId} id="account-keys">
      <SectionLabel as="h2" id={titleId}>
        {t.title}
      </SectionLabel>
      <p className={c.hint}>{t.line(account)}</p>
      {groups.map((group) => (
        <div key={group.title} className={styles.card}>
          <div className={k.tool}>
            <h3 className={k.keyGroup}>{group.title}</h3>
          </div>
          <ul className={k.tools} aria-label={group.title}>
            {group.rows.map((row) => (
              <KeyRow
                key={row.keyId}
                row={row}
                label={t.tiersLabel(row.label)}
                pending={setKeys.isPending}
                onChange={(tier) => void change(row.keyId, tier)}
              />
            ))}
          </ul>
        </div>
      ))}
      {problem && (
        <p className={c.error} role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

function KeyRow({
  row,
  label,
  pending,
  onChange,
}: {
  row: AccountKeyRow;
  label: string;
  pending: boolean;
  onChange: (tier: Tier) => void;
}) {
  return (
    <li className={k.tool} data-key={row.keyId}>
      <span className={k.toolMain}>
        <span>{row.label}</span>
        {row.note && <span className={c.meta}>{row.note}</span>}
      </span>
      <SegmentedControl<Tier>
        label={label}
        size="sm"
        value={row.tier}
        disabled={pending}
        onChange={onChange}
        options={row.choices.map((value) => ({ value, label: ACCOUNT_TIER_LABELS[value] }))}
      />
    </li>
  );
}
