/**
 * TalkBack (and VoiceOver) walk the accessibility tree in source/DOM order, which on React Native is
 * layout order unless something overrides it (`row-reverse`, `position: 'absolute'` siblings, `zIndex`,
 * `accessibilityViewIsModal` without a backdrop). The approval, DM, Vault and Chat screens read top-to-bottom /
 * left-to-right with no such override, so what's read matches what's shown. This is a static regression
 * guard: it fails loudly if one of these flows starts reordering visually without reordering the tree,
 * rather than proving correctness (see docs/decisions/accessibility.md for the manual TalkBack pass).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../', import.meta.url);

/** Screens/components that make up the approval, DM, Vault and Chat reading order. */
const FLOW_FILES = [
  'screens/ApprovalScreen.tsx',
  'screens/VaultScreen.tsx',
  'screens/VaultEntryScreen.tsx',
  'screens/ConversationScreen.tsx',
  'screens/ChatView.tsx',
  'screens/MessageRow.tsx',
  'ui/chat.tsx',
  'ui/guide.tsx',
  // A feature request's card in a thread.
  'ui/featureRequestCard.tsx',
  'ui/ListRow.tsx',
  // What answers in Chat (chat-runtime-android.md AP-2715…AP-2728): the icon in the pill, a reply's mark and divider, the sheet.
  'ui/chatRuntime.tsx',
  'screens/ChatRuntimeSheet.tsx',
  // Voice typing's mic and recording bar in the composer (docs/decisions/dictation.md).
  'voice/VoiceBar.tsx',
];

// `accessibilityViewIsModal` is fine on a sheet/modal whose backdrop sits earlier in the tree (`ui/sheet.tsx`); it is
// not part of these three flows and is intentionally not allow-listed here.
const ORDER_BREAKING_PATTERNS = [/row-reverse/, /position:\s*['"]absolute['"]/, /\bzIndex\b/];

/** The parity screens (mobile-parity.md MQ-01…MQ-06): read top to bottom as shown, too. */
const PARITY_FILES = [
  // The assistant's page, its parts and Advanced's (one-agent.md AP-4965).
  'screens/AgentSettingsScreen.tsx',
  'screens/ServicesSection.tsx',
  'screens/agent/NotesSection.tsx',
  'screens/agent/KeysPart.tsx',
  'screens/agent/MayPart.tsx',
  'screens/agent/LooksAheadPart.tsx',
  'settings/AdvancedScreens.tsx',
  'screens/SpendScreen.tsx',
  'screens/AuditLogScreen.tsx',
  'ui/facts.tsx',
  'screens/CanvasScreen.tsx',
  'screens/DeploysPanel.tsx',
  'screens/DeploysScreen.tsx',
  // The shell (phone-shell-final.md): Places and Search read top to bottom as shown.
  'ui/places.tsx',
  'ui/topRow.tsx',
  'screens/SearchScreen.tsx',
  // Backup file (backup-file-android.md AP-1220): both panels read top to bottom as shown.
  'managed/BackupFileScreen.tsx',
  // This Whombat in parts (this-whombat-sections-android.md AP-1251): the Overview, Backups, Devices, About.
  'managed/WhombatScreen.tsx',
  'managed/WhombatBackupsScreen.tsx',
  'managed/DevicesScreen.tsx',
  'managed/WhombatAboutScreen.tsx',
  'managed/HostStatus.tsx',
  // The desk screen (desk-display-android.md AP-3057): SCREEN and the unlock request read top to bottom as shown.
  'managed/DeskSection.tsx',
  'managed/DeskUnlockCard.tsx',
  // Settings → Screen (desk-display-android.md AP-5865): the page and What it shows read top to bottom as shown; the
  // preview inside it is one picture to TalkBack (`DeskPreviewScreen`, its words read as one line).
  'settings/DeskScreenPage.tsx',
  'settings/DeskShowsPart.tsx',
  // Settings → Screens (desk-display-android.md AP-6000…AP-6022): the list, a screen's page, the editor and its sheets read
  // top to bottom as shown. The grid's tiles are placed over its cells, in reading order (a test below).
  'settings/screens/ScreensList.tsx',
  'settings/screens/ScreenPage.tsx',
  'settings/screens/LayoutEditor.tsx',
  'settings/screens/WidgetSheet.tsx',
  'settings/screens/AddWidgetSheet.tsx',
  // The machine (hardware-support-android.md AP-3258): NETWORK, the Wi-Fi sheet and HARDWARE read top to bottom as shown.
  'managed/NetworkSection.tsx',
  'managed/WifiSheet.tsx',
  'managed/HardwareSection.tsx',
  'managed/MachineParts.tsx',
  // Bluetooth (bluetooth-android.md AP-3758): BLUETOOTH and the Add a device sheet read top to bottom as shown.
  'managed/BluetoothSection.tsx',
  'managed/BluetoothSheet.tsx',
  // Remote help (app remote-help.md AP-4479): REMOTE HELP and the command line's sheet read top to bottom as shown.
  'managed/RemoteHelpSection.tsx',
  // One Whombat (one-whombat-mobile.md AP-1378): Connections, a server, Chats, a chat, Watch, their sheets and cards.
  'screens/HomeScreen.tsx',
  'screens/NeedsYouSheet.tsx',
  // Point them here (backup-file.md AP-4421): the servers and their state read top to bottom as shown.
  'screens/RepointServersScreen.tsx',
  'screens/ThingScreen.tsx',
  'screens/ServerScreen.tsx',
  // A guest's screen and a server's Backups (proxmox-mobile.md AP-1485…AP-1500).
  'screens/GuestScreen.tsx',
  'screens/guest/parts.tsx',
  'screens/guest/GuestSummary.tsx',
  'screens/guest/GuestSettings.tsx',
  'screens/guest/GuestSheets.tsx',
  'screens/guest/GuestSnapshots.tsx',
  'screens/guest/GuestBackups.tsx',
  'screens/guest/GuestTasks.tsx',
  'screens/ServerBackups.tsx',
  // Incus, Unraid and the self guest (incus-unraid-mobile.md AP-1617…).
  'screens/guest/IncusSettings.tsx',
  'screens/guest/IncusSheets.tsx',
  'screens/guest/IncusBackups.tsx',
  'screens/guest/IncusSummary.tsx',
  'screens/guest/ContainerCard.tsx',
  'screens/server/IncusServer.tsx',
  'screens/server/UnraidParts.tsx',
  'screens/server/UnraidSheets.tsx',
  'screens/guest/LibvirtSettings.tsx',
  'screens/guest/LibvirtSheets.tsx',
  'screens/server/LibvirtServer.tsx',
  // Add a server (server-signin-mobile.md AP-1712).
  'screens/AddServerScreen.tsx',
  // A connection's page (connection-pages-mobile.md AP-1950…).
  'screens/ThingPageScreen.tsx',
  'screens/thing/ThingTabs.tsx',
  'screens/thing/Panels.tsx',
  'screens/thing/Changes.tsx',
  'screens/thing/parts.tsx',
  // Quiet notices (quiet-notices-mobile.md AP-4861, AP-4865): a line's ⋯ menu and What Whombat watches.
  'screens/thing/QuietMenu.tsx',
  'screens/thing/WhatWhombatWatches.tsx',
  'screens/ConnectionScreen.tsx',
  'screens/NewChatSheet.tsx',
  'screens/ChatScreen.tsx',
  // Chat (chat-channel.md AP-2461): the rooms, Settled, a room's thread header and the subject's chip.
  'screens/ChatRoomScreen.tsx',
  // Chat as an inbox: the filters, then the rows top to bottom (chat-inbox-phone.md).
  'screens/ChatInbox.tsx',
  'screens/SettledScreen.tsx',
  'screens/ThreadScreen.tsx',
  'ui/subjectChip.tsx',
  // Settling threads (chat-settle.md AP-6157): the settled line, Settle, the swipe row and Profile's CHAT.
  'ui/threadSettle.tsx',
  'ui/swipeRow.tsx',
  'settings/ChatSettleSection.tsx',
  'screens/NeedsYouScreen.tsx',
  'ui/assistant.tsx',
  'ui/oneSheet.tsx',
  'ui/deviceSkillCard.tsx',
  // Connections (connections-page.md AP-2553; home-redesign-mobile.md AP-2268): its groups and Everything I did.
  'screens/home/Section.tsx',
  'screens/home/ServersCard.tsx',
  'screens/home/ServicesCard.tsx',
  'screens/home/DoneParts.tsx',
  'screens/home/PanelsCards.tsx',
  // The arranged Overview (overview-arranged.md): the summary card, Today, the parts and a gear's sheet.
  'screens/home/SummaryCard.tsx',
  'screens/home/TodayCard.tsx',
  'screens/home/ArrangedParts.tsx',
  'screens/home/ArrangeSheets.tsx',
  'screens/DoneScreen.tsx',
  // Tabs with an underline (underline-tabs-android.md AP-2636): the tabs, then a trailing Settings, as shown.
  'ui/UnderlineTabs.tsx',
  // Connecting from the phone (phone-connect.md PC-11, AP-2915): Connect {Name}, a builtin's screen and their parts.
  'screens/ConnectScreen.tsx',
  'screens/ConnectAccountScreen.tsx',
  'screens/connect/parts.tsx',
  'screens/connect/AppSetup.tsx',
  'screens/connect/Imap.tsx',
  'screens/connect/FoundOnNetwork.tsx',
  'screens/connect/ConnectionChanges.tsx',
  'ui/radioCards.tsx',
];

describe('TalkBack/VoiceOver reading order', () => {
  it('keeps the parity screens free of layout-order overrides', () => {
    const offenders: string[] = [];
    for (const file of PARITY_FILES) {
      const source = readFileSync(new URL(file, SRC), 'utf8');
      for (const pattern of ORDER_BREAKING_PATTERNS) {
        if (pattern.test(source)) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reads the floating “New messages ↓” pill after the list and before the composer, where it shows (MX-01)', () => {
    // The pill floats (`ui/jumpPill.tsx` is absolutely positioned over the list's bottom edge), so it lives outside the
    // chat files above; in ChatView's tree it comes right after the list and before the outbox rows and the composer.
    const source = readFileSync(new URL('screens/ChatView.tsx', SRC), 'utf8');
    const list = source.indexOf('<FlatList');
    const pill = source.indexOf('<NewMessagesPill');
    const composer = source.indexOf('<Composer');
    expect(list).toBeGreaterThan(0);
    expect(pill).toBeGreaterThan(list);
    expect(composer).toBeGreaterThan(pill);
    const pillFile = readFileSync(new URL('ui/jumpPill.tsx', SRC), 'utf8');
    expect(pillFile).toMatch(/position:\s*'absolute'/);
    expect(pillFile).not.toMatch(/zIndex|row-reverse/);
  });

  it('reads the floating toast after the screens, so its Undo comes after what it is about (AP-4864)', () => {
    // The toast floats over the bottom of every screen (`ui/Toast.tsx` is absolutely positioned); in the navigator's tree
    // it comes after the stack, so TalkBack reaches it after the screen whose line it took back.
    const source = readFileSync(new URL('navigation/RootNavigator.tsx', SRC), 'utf8');
    const stack = source.lastIndexOf('</Stack.Navigator>');
    const toast = source.indexOf('<ToastHost');
    expect(stack).toBeGreaterThan(0);
    expect(toast).toBeGreaterThan(stack);
    const toastFile = readFileSync(new URL('ui/Toast.tsx', SRC), 'utf8');
    expect(toastFile).toMatch(/position:\s*'absolute'/);
    expect(toastFile).not.toMatch(/zIndex|row-reverse/);
  });

  it('reads a screen’s tiles row by row, left to right, as they are drawn over the cells (AP-6013)', () => {
    // The tiles sit over the cells (`position: 'absolute'`), so their order in the tree is the page's widgets' order,
    // which `draftPage` sorts by row then column; the cells under them are hidden from TalkBack, and nothing is raised.
    const grid = readFileSync(new URL('settings/screens/TileGrid.tsx', SRC), 'utf8');
    expect(grid).not.toMatch(/zIndex|row-reverse/);
    expect(grid).toMatch(/importantForAccessibility="no-hide-descendants"/);
    expect(grid.indexOf('{children}')).toBeGreaterThan(grid.indexOf('{empty}'));
    const draft = readFileSync(new URL('settings/screens/draft.ts', SRC), 'utf8');
    expect(draft).toMatch(/sort\(\(a, b\) => a\.y - b\.y \|\| a\.x - b\.x\)/);
    // Add a screen reads top to bottom; its one overlay is the six letters' field over its boxes, which TalkBack doesn't
    // read: one field, “The six letters”.
    const add = readFileSync(new URL('settings/screens/AddScreenSheet.tsx', SRC), 'utf8');
    expect(add.match(/position:\s*'absolute'/g)).toHaveLength(1);
    expect(add).not.toMatch(/zIndex|row-reverse/);
  });

  it('reads Name and character top to bottom; its only overlay is the chosen face’s decorative check (AP-1540, AP-4966)', () => {
    // The mock's check badge sits on the chosen tile's corner (`position: 'absolute'`), drawn after the face and never
    // focusable: the tile is the radio, named “Neo’s face”, selected.
    const source = readFileSync(new URL('screens/agent/NameAndFacePart.tsx', SRC), 'utf8');
    expect(source.match(/position:\s*'absolute'/g)).toHaveLength(1);
    expect(source).not.toMatch(/zIndex|row-reverse/);
    const face = source.indexOf('<WhombatAvatar face={c.key}');
    const badge = source.indexOf("position: 'absolute'");
    expect(face).toBeGreaterThan(0);
    expect(badge).toBeGreaterThan(face);
  });

  it('reads New chat after the list it floats over (AP-9380)', () => {
    // The round button sits over the list's corner (`position: 'absolute'`); in the tree it comes after the list, so a
    // screen reader reaches the threads first and nothing is raised over them.
    const button = readFileSync(new URL('ui/newChatButton.tsx', SRC), 'utf8');
    expect(button).toMatch(/position:\s*'absolute'/);
    expect(button).not.toMatch(/zIndex|row-reverse/);
    const inbox = readFileSync(new URL('screens/ChatInbox.tsx', SRC), 'utf8');
    expect(inbox.indexOf('<NewChatButton')).toBeGreaterThan(inbox.indexOf('<FlatList'));
  });

  it('keeps the approval, DM, Vault and Chat flows free of layout-order overrides', () => {
    const offenders: string[] = [];
    for (const file of FLOW_FILES) {
      const source = readFileSync(new URL(file, SRC), 'utf8');
      for (const pattern of ORDER_BREAKING_PATTERNS) {
        if (pattern.test(source)) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
