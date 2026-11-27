/**
 * Pinned, Overview's last section (docs/decisions/overview-one-page.md, overview-server-connection-final.md
 * and overview-arranged.md): what was pinned from a chat and not removed from the Overview, one card per
 * panel in the viewer's order, drawn with the same chart block as a thing page's kept widgets (`WidgetBlock`: the
 * title, the latest values, a finger picks a moment, the lines, where it came from), under its heading. On a phone each
 * takes the full width, whatever its width on a computer. While the page is arranged each card has its gear.
 */
import { arrangeWords, type OverviewSectionView } from '@whombat/client';
import type { Widget } from '@whombat/core';
import { View } from 'react-native';
import { useI18n } from '../../i18n';
import { OneCard } from '../../ui/assistant';
import { WidgetBlock } from '../thing/Panels';
import { GearButton } from './ArrangedParts';
import { OverviewSection } from './Section';

export function PanelsCards({
  view,
  widgets,
  arranging = false,
  onGear,
}: {
  view: OverviewSectionView;
  widgets: readonly Widget[];
  arranging?: boolean;
  onGear?: (id: string) => void;
}) {
  const { rawLocale } = useI18n();
  const arrangeWordsHere = arrangeWords(rawLocale);
  return (
    <OverviewSection label={view.label} count={view.count} summary={view.summary}>
      <View style={{ gap: 12 }}>
        {widgets.map((w) => (
          <OneCard key={w.id}>
            {arranging ? (
              <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <WidgetBlock widget={w} first />
                </View>
                <View style={{ paddingTop: 12, paddingRight: 12 }}>
                  <GearButton label={arrangeWordsHere.changePin(w.title)} onPress={() => onGear?.(w.id)} />
                </View>
              </View>
            ) : (
              <WidgetBlock widget={w} first />
            )}
          </OneCard>
        ))}
      </View>
    </OverviewSection>
  );
}
