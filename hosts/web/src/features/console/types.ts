// Integration contract between the server page (phase 1) and the console /
// Screens wall (phase 2). The server page renders these components *inside
// the guests card*, in place of the guest table; the platform tabs stay above.

import type { Guest, ServerDetail } from '../../api/types';

export interface ConsolePanelProps {
  /** Detail body of the host (GET /servers/{id}); `server.remote_control` holds the permissions. */
  server: ServerDetail;
  /** The guest whose console is open (from the route `/servers/:id/guests/:guestId/console`). */
  guest: Guest;
  /** All guests of the same platform on this host (for the side list), sorted by CPU. */
  guests: Guest[];
  /** Caption of the side list ("Incus instances", "libvirt VMs", "QEMU / KVM VMs", "LXC containers"). */
  listTitle: string;
  /** Requested connection type from `?protocol=` (null = the guest's default_protocol). */
  protocol: string | null;
  /** Change `?protocol=` (reconnect with the selected protocol). */
  onProtocolChange: (protocol: string) => void;
  /** Switch the console to another guest of the side list (stays in the card). */
  onSelectGuest: (guestId: string) => void;
  /** "← Guests": close the console and return to the list (or the Screens wall). */
  onClose: () => void;
  /** Side-panel layout (UI v2): no side list, the list is the table next to the panel; the back button reads "Close". */
  compact?: boolean;
}

export interface ScreensWallProps {
  /** Detail body of the host. */
  server: ServerDetail;
  /** Guests of the selected platform, sorted by CPU (already filtered by name). */
  guests: Guest[];
  /** Open the console of a tile's guest. */
  onOpenConsole: (guestId: string) => void;
  /** Back to the List view. */
  onClose: () => void;
}
