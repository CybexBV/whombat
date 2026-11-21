import { BrandMark } from '@whombat/brand/react';
import type { GuideIcon, GuideIconName } from '@whombat/core/domain';
import {
  Bell,
  Calendar,
  CircleQuestionMark,
  Clock,
  FileText,
  Folder,
  KeyRound,
  Link,
  type LucideIcon,
  Mail,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  UserPlus,
} from 'lucide-react';

/** The Lucide subset a guide may name (CT-80), drawn in the text colour. `key` is Lucide's key-round, as elsewhere. */
const GUIDE_LUCIDE: Record<GuideIconName, LucideIcon> = {
  mail: Mail,
  calendar: Calendar,
  folder: Folder,
  'file-text': FileText,
  sun: Sun,
  clock: Clock,
  sparkles: Sparkles,
  key: KeyRound,
  link: Link,
  'shield-check': ShieldCheck,
  'circle-help': CircleQuestionMark,
  'user-plus': UserPlus,
  bell: Bell,
  settings: Settings,
};

/** A choice's icon at 24px: a provider's mark (AG-16) or a Lucide icon. Decorative: the title names it. */
export function GuideIconView({ icon, className }: { icon: GuideIcon; className?: string }) {
  if ('brand' in icon) return <BrandMark mark={icon.brand} size={24} className={className} />;
  const Glyph = GUIDE_LUCIDE[icon.icon];
  return <Glyph size={22} strokeWidth={1.75} aria-hidden="true" focusable="false" className={className} />;
}
