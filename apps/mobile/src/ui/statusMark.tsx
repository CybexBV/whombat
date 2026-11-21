/**
 * The status scale by shape, as on the web (docs/app/decisions/phone-refresh-status.md): not working is a dot inside a
 * ring, needs a look a filled dot, learning a hollow ring, connected nothing. Shape carries the level without its
 * colour. The level and its words come from the shared `statusLevel` (`@whombat/client`).
 */
import type { StatusLevel } from '@whombat/client';
import type { NativeTheme as Theme } from '@whombat/tokens';
import { View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';

/** The level's colour as text (a pill's word, a row's word): the status text tokens pass 4.5:1 on every surface. */
export function levelTextColor(theme: Theme, level: StatusLevel): string {
  switch (level) {
    case 'notWorking':
      return theme.colors.bad;
    case 'needsLook':
      return theme.colors.warnText;
    case 'learning':
      return theme.colors.mut;
    case 'connected':
      return theme.colors.okText;
  }
}

/**
 * A level's mark: 12pt ring with a 6pt dot (`bad`), an 8pt filled dot (`warn`), a 10pt hollow ring (`mut`), nothing
 * when connected. With `label` it is an image with that name (“blackbox: disk array failed”); without, decoration
 * beside words that say it.
 */
export function StatusMark({ level, label }: { level: StatusLevel; label?: string | null }) {
  const theme = useTheme();
  if (level === 'connected') return null;
  const a11y = label
    ? { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel: label }
    : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };
  return (
    <View {...a11y} style={{ width: 12, height: 12, alignItems: 'center', justifyContent: 'center' }}>
      {level === 'notWorking' ? (
        <View
          style={{
            width: 12,
            height: 12,
            borderRadius: 6,
            borderWidth: 1.5,
            borderColor: theme.colors.bad,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.bad }} />
        </View>
      ) : level === 'needsLook' ? (
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.warn }} />
      ) : (
        <View
          style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: theme.colors.mut }}
        />
      )}
    </View>
  );
}

/**
 * A status pill (the web's `LevelPill`): the mark and its word in mono 11.5/500, the level's text colour on `sf2`, 24
 * tall. Connected has a small filled `ok` dot so the pills keep one shape. Decoration: the card's or head's name says it.
 */
export function LevelPill({ level, word }: { level: StatusLevel; word: string }) {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        gap: 6,
        minHeight: 24,
        paddingHorizontal: 9,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: theme.colors.sf2,
      }}
    >
      {level === 'connected' ? (
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.ok }} />
      ) : (
        <StatusMark level={level} />
      )}
      <Text
        size={11.5}
        weight={500}
        mono
        tracking={0.02}
        color={levelTextColor(theme, level)}
        style={{ flexShrink: 1 }}
      >
        {word}
      </Text>
    </View>
  );
}
