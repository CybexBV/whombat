/**
 * WHAT {ASSISTANT} MAY DO on the phone's Google and Microsoft 365 screen (Whombat accounts.md; the web's AccountKeys):
 * the keys to the person's own account by service, Allowed · Asks · Off (sending, invites and sharing only Asks · Off),
 * saved at once with every other key as it is.
 */
import {
  ACCOUNT_TIER_LABELS,
  accountKeyGroups,
  accountKeysText,
  withAccountTier,
} from '@whombat/client/connections';
import { useAgent, useSetAgentKeys } from '@whombat/client/react';
import type { ConnectorService } from '@whombat/core';
import type { KeyId, Tier } from '@whombat/core/keys';
import { useState } from 'react';
import { View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { useTheAgentHere } from '../../data/useAgent';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { CardLine } from '../../ui/facts';
import { TierSegmentRow } from '../../ui/keyRows';
import { Section } from '../../ui/primitives';
import { showNotice } from '../feedback';

export function AccountKeys({
  account,
  services,
  title,
}: {
  /** “Google”, “Microsoft 365”. */
  account: string;
  services: readonly ConnectorService[];
  /** The screen's own section title. */
  title: (text: string) => React.ReactNode;
}) {
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const agent = useTheAgentHere()?.name ?? '';
  const query = useAgent({ params: { burrow: slug } }, { retry: false });
  const setKeys = useSetAgentKeys(slug);
  const [problem, setProblem] = useState<string | null>(null);
  const profile = query.data;
  if (!profile) return null;
  const t = accountKeysText(agent);
  const groups = accountKeyGroups(profile.grants, services, agent);
  if (groups.length === 0) return null;

  async function change(keyId: KeyId, tier: Tier) {
    if (!profile) return;
    setProblem(null);
    try {
      const result = await setKeys.mutateAsync({
        params: { burrow: slug },
        body: { grants: withAccountTier(profile.grants, keyId, tier) },
      });
      if (result.status === 'ok') showNotice(t.saved);
      else setProblem(result.status === 'blocked' ? result.message : t.failed);
    } catch {
      setProblem(t.failed);
    }
  }

  return (
    <View style={{ gap: 12 }}>
      {title(t.title)}
      <Text size={13} lh={1.4} color={theme.colors.mut}>
        {t.line(account)}
      </Text>
      <CardLine text={problem} tone="bad" />
      {groups.map((group) => (
        <Section key={group.title} title={group.title}>
          {group.rows.map((row) => (
            <TierSegmentRow
              key={row.keyId}
              label={row.label}
              description={row.note}
              tier={row.tier}
              disabled={setKeys.isPending}
              options={row.choices.map((value) => ({ value, label: ACCOUNT_TIER_LABELS[value] }))}
              onChange={(tier) => void change(row.keyId, tier)}
            />
          ))}
        </Section>
      ))}
    </View>
  );
}
