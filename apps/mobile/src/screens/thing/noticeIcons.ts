/**
 * The icons of Worth a look's lines and of list lines in Lucide, as on the web: a notice's kind, a library's kind
 * (film, tv, music, photo, video: Whombat service-slots.md SLT-03).
 */
import type { ThingNoticeIcon } from '@whombat/core';
import {
  Archive,
  BadgeCheck,
  Banknote,
  Battery,
  Camera,
  CircleArrowUp,
  Clock,
  Cpu,
  Database,
  DoorOpen,
  Download,
  Film,
  HardDrive,
  ImageIcon,
  Info,
  Key,
  type LucideIcon,
  Music,
  Network,
  Plug,
  Power,
  ScrollText,
  ShieldCheck,
  TriangleAlert,
  Tv,
  Video,
} from '../../ui/icons';

export const NOTICE_ICONS: Record<ThingNoticeIcon, LucideIcon> = {
  disk: HardDrive,
  plug: Plug,
  log: ScrollText,
  update: CircleArrowUp,
  backup: Archive,
  network: Network,
  power: Power,
  battery: Battery,
  database: Database,
  clock: Clock,
  key: Key,
  device: Cpu,
  info: Info,
  warn: TriangleAlert,
  // Contracts 0.121 (CT-1007; service-dashboards.md).
  download: Download,
  camera: Camera,
  door: DoorOpen,
  media: Film,
  money: Banknote,
  shield: ShieldCheck,
  certificate: BadgeCheck,
  // A library's kind.
  film: Film,
  tv: Tv,
  music: Music,
  photo: ImageIcon,
  video: Video,
};
