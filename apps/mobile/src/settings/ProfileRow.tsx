/**
 * Settings → Profile's first row on the phone: your avatar, name and email, and your photo (contracts CT-265,
 * docs/decisions/person-avatars.md PA-06) — the avatar itself and “Change photo” open the library with a square crop,
 * “Remove photo” goes back to the initials. Account-wide, like the web's (`me.setAvatar`); only on a Whombat with
 * `people.avatars`, never in the demo world (it has no account). What happened is said under the buttons and announced.
 */

import { useQueryClient } from '@tanstack/react-query';
import { AVATAR_COPY, avatarErrorText } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { useWhombat } from '@whombat/client/react';
import type { Person } from '@whombat/core';
import { useState } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { PersonAvatar } from '../avatars/Avatars';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Button } from '../ui/primitives';
import { Touchable } from '../ui/Touchable';
import { pickPhoto } from './photo';

export function ProfileRow({ me, demo }: { me: Person; demo: boolean }) {
  const theme = useTheme();
  const { client } = useWhombat();
  const qc = useQueryClient();
  const photos = !demo;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  const say = (text: string, bad: boolean) => {
    setNote({ text, bad });
    AccessibilityInfo.announceForAccessibility(text);
  };

  /** A new photo (`pick` gives its base64, or null when cancelled) or none (`remove`). */
  const save = async (remove: boolean) => {
    setBusy(true);
    try {
      const image = remove ? null : await pickPhoto();
      if (!remove && image === null) return;
      const result = await client.me.setAvatar({ body: { image } });
      if (result.status !== 'ok') return;
      // You, in this burrow's bootstrap (the account is everywhere: `person.updated` follows).
      void qc.invalidateQueries({ queryKey: queryKeys.scope('conversations.bootstrap') });
      say(remove ? AVATAR_COPY.removed : AVATAR_COPY.saved, false);
    } catch (error) {
      say(avatarErrorText(error), true);
    } finally {
      setBusy(false);
    }
  };

  // Decorative: the name is right beside it.
  const avatar = <PersonAvatar person={me} size={44} />;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        {photos ? (
          // 44dp: the avatar is the touch target to a new photo, with its focus ring.
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={AVATAR_COPY.change}
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => void save(false)}
            ringRadius={22}
            style={{ borderRadius: 22 }}
          >
            {avatar}
          </Touchable>
        ) : (
          avatar
        )}
        <View style={{ flex: 1 }}>
          <Text size={19} weight={700} tracking={-0.01}>
            {me.name}
          </Text>
          <Text size={12} mono color={theme.colors.mut} numberOfLines={1}>
            {demo ? `${me.title ?? me.email} · demo` : me.email}
          </Text>
        </View>
      </View>
      {photos ? (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button
              label={AVATAR_COPY.change}
              variant="secondary"
              busy={busy}
              onPress={() => void save(false)}
              style={{ flex: 1 }}
            />
            {me.avatarUrl ? (
              <Button
                label={AVATAR_COPY.remove}
                variant="quiet"
                disabled={busy}
                onPress={() => void save(true)}
                style={{ flex: 1 }}
              />
            ) : null}
          </View>
          {note ? (
            <Text
              size={13}
              color={note.bad ? theme.colors.bad : theme.colors.mut}
              style={{ paddingHorizontal: 6 }}
            >
              {note.text}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
