/**
 * The assistant's AI sign-in (was Settings → AI): a card per provider with how much is left, and the way to sign in on
 * the web. Pulling down reads the sign-ins again. Which model it uses is Advanced's, and so is Spend.
 */
import { useClients, useSignIns } from '@whombat/client/react';
import { useState } from 'react';
import { View } from 'react-native';
import { AiSignIns } from '../../settings/AiSection';
import { PartScroll } from './parts';

export function AiPart() {
  // The cards' own reads (the same cache): pulling down asks them again.
  const signIns = useSignIns({}, { retry: false });
  const clients = useClients({}, { retry: false });
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([signIns.refetch(), clients.refetch()]).catch(() => {});
    setRefreshing(false);
  };
  return (
    <PartScroll refreshing={refreshing} onRefresh={() => void refresh()}>
      <View style={{ paddingHorizontal: 16, gap: 18 }}>
        <AiSignIns />
      </View>
    </PartScroll>
  );
}
