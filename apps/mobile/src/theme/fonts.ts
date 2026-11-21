/**
 * Bricolage Grotesque (400–700) and DM Mono (400/500), bundled with the app and registered under the
 * family names `@whombat/tokens` `nativeFontFamilies` uses. Per-weight imports keep unused weights out
 * of the bundle.
 */
import { BricolageGrotesque_400Regular } from '@expo-google-fonts/bricolage-grotesque/400Regular';
import { BricolageGrotesque_500Medium } from '@expo-google-fonts/bricolage-grotesque/500Medium';
import { BricolageGrotesque_600SemiBold } from '@expo-google-fonts/bricolage-grotesque/600SemiBold';
import { BricolageGrotesque_700Bold } from '@expo-google-fonts/bricolage-grotesque/700Bold';
import { DMMono_400Regular } from '@expo-google-fonts/dm-mono/400Regular';
import { DMMono_500Medium } from '@expo-google-fonts/dm-mono/500Medium';
import { useFonts } from 'expo-font';

export const APP_FONTS = {
  BricolageGrotesque_400Regular,
  BricolageGrotesque_500Medium,
  BricolageGrotesque_600SemiBold,
  BricolageGrotesque_700Bold,
  DMMono_400Regular,
  DMMono_500Medium,
};

/** True once the fonts are ready (or failed to load: the system font keeps the UI usable). */
export function useAppFonts(): boolean {
  const [loaded, error] = useFonts(APP_FONTS);
  return loaded || error != null;
}
