/**
 * A task chat's address (`/chats/<id>`, a `chat` link, a restored place; Whombat chat-channel.md CHT-21;
 * chat-channel.md AP-2457, one-layout-android.md AP-2640): since Chat there are no task chats to open, so it opens the
 * Feedback room for that room's id, else Chat. Nothing is drawn while the rooms load.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { chatRedirectPath } from '@whombat/client';
import { useChatRooms } from '@whombat/client/react';
import { useEffect } from 'react';
import { useBurrowBase } from '../data/BurrowProvider';
import type { RootStackParamList } from '../navigation/routes';
import { Screen } from '../ui/headers';

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

export function ChatScreen({ route, navigation }: Props) {
  const { slug } = useBurrowBase();
  const rooms = useChatRooms(slug);
  const redirect = !rooms.known && !rooms.error ? null : chatRedirectPath(rooms, route.params.conversationId);
  useEffect(() => {
    if (redirect === '/feedback') navigation.replace('Feedback');
    else if (redirect === '/chat') navigation.popTo('Tabs', { screen: 'ChatRoom' });
  }, [redirect, navigation]);
  return <Screen>{null}</Screen>;
}
