/**
 * Pinned, Overview's last section (docs/decisions/overview-one-page.md OVP-12; overview-server-connection-final.md
 * OSC-07): what was pinned from a chat, one card per panel in the viewer's order, drawn with the same chart block as a
 * thing page's kept widgets (`WidgetBlock`: the title, the latest values, a finger picks a moment, the lines, where it
 * came from), under its heading.
 */
import type { OverviewSectionView } from '@whombat/client';
import type { Widget } from '@whombat/core';
import { View } from 'react-native';
import { OneCard } from '../../ui/assistant';
import { WidgetBlock } from '../thing/Panels';
import { OverviewSection } from './Section';

export function PanelsCards({ view, widgets }: { view: OverviewSectionView; widgets: readonly Widget[] }) {
  return (
    <OverviewSection label={view.label} count={view.count} summary={view.summary}>
      <View style={{ gap: 12 }}>
        {widgets.map((w) => (
          <OneCard key={w.id}>
            <WidgetBlock widget={w} first />
          </OneCard>
        ))}
      </View>
    </OverviewSection>
  );
}
