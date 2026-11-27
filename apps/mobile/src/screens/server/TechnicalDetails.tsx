/**
 * A server's one “Technical details” fold at the foot of its Summary on the phone (Whombat server-pages.md): closed, a
 * quiet 44dp row; open, its versions, processor, memory, address and Whombat's helper as label and value, then the
 * cards only someone who runs it needs (storage and pools, the platform's facts, the cluster).
 */

import type { ServerDetailRow } from '@whombat/client/hosts';
import type { ThingPagePanel } from '@whombat/core';
import { useState } from 'react';
import { View } from 'react-native';
import { serverCopy } from '../../data/servers';
import { useI18n } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { OneCard } from '../../ui/assistant';
import { ChevronDown, ChevronRight } from '../../ui/icons';
import { Touchable } from '../../ui/Touchable';
import { type PanelContext, SummaryPanels } from '../thing/Panels';

export function TechnicalDetailsCard({
  rows,
  panels,
  ctx,
}: {
  rows: readonly ServerDetailRow[];
  panels: readonly ThingPagePanel[];
  ctx: PanelContext;
}) {
  const { rawLocale } = useI18n();
  const serverCopyHere = serverCopy(rawLocale);

  const theme = useTheme();
  const [open, setOpen] = useState(false);
  if (!rows.length && !panels.length) return null;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <OneCard>
        <Touchable
          onPress={() => setOpen(!open)}
          feedback="wash"
          accessibilityRole="button"
          accessibilityLabel={serverCopyHere.technical}
          accessibilityState={{ expanded: open }}
          style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14 }}
        >
          <Chevron size={16} color={theme.colors.ink2} />
          <Text size={14} weight={500} color={theme.colors.ink2}>
            {serverCopyHere.technical}
          </Text>
        </Touchable>
        {open
          ? rows.map((r) => (
              <View
                key={r.label}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  gap: 2,
                  borderTopWidth: 1,
                  borderTopColor: theme.colors.line,
                }}
              >
                <Text size={12.5} color={theme.colors.mut}>
                  {r.label}
                </Text>
                <Text size={14.5} weight={500} mono={!!r.mono} selectable>
                  {r.value}
                </Text>
              </View>
            ))
          : null}
      </OneCard>
      {open && panels.length ? <SummaryPanels panels={panels} ctx={ctx} range={null} /> : null}
    </>
  );
}
