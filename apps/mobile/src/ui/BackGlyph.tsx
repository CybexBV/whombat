/**
 * The back arrow on Android: Material's `arrow_back` (Lucide's arrow-left draws the same shape), 24dp in `ink` as a top
 * app bar's navigation icon. Decorative: the button around it says where it goes. iPhone has its own (`.ios.tsx`).
 */
import { useTheme } from '../theme/theme';
import { ArrowLeft } from './icons';

export function BackGlyph() {
  const theme = useTheme();
  return <ArrowLeft size={24} color={theme.colors.ink} strokeWidth={2} />;
}
