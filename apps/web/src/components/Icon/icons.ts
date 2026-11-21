/**
 * Icon slots. The mocks use geometric placeholders (circle, rounded square, square outlined 1.7px)
 * and a few text glyphs; README "Icons" asks for one line-icon set at 16–18px in the same slots.
 * We use Lucide (decision in docs/decisions/tokens-primitives.md). Each entry names the slot and where
 * the mock uses it; screens refer to slots by name so the set can be swapped in one place.
 */
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  AtSign,
  Bell,
  Check,
  ChevronDown,
  CircleQuestionMark,
  createLucideIcon,
  Download,
  Ellipsis,
  File,
  FileText,
  Folder,
  FolderCheck,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Hash,
  Inbox,
  KeyRound,
  ListChecks,
  Lock,
  type LucideIcon,
  MailCheck,
  Maximize2,
  Menu,
  MessageCircle,
  MessageSquareReply,
  MessagesSquare,
  Minimize2,
  Monitor,
  Moon,
  Pause,
  PawPrint,
  Pin,
  PinOff,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  ScrollText,
  Search,
  Server,
  Settings,
  Share2,
  ShieldCheck,
  Slash,
  SquarePen,
  Sun,
  Trash2,
  Users,
  X,
} from 'lucide-react';

/**
 * John's wombat (docs/decisions/ask-agent.md AP-954): the brand mark's face as a 24×24 line icon — head, ears, eyes and
 * nose — drawn on Lucide's grid (stroke 2, round caps and joins), so it takes the slots' size, `currentColor` and the
 * 1.75px absolute stroke like any Lucide icon.
 */
export const WombatFace = createLucideIcon({
  name: 'whombat-face',
  size: 24,
  node: [
    [
      'path',
      {
        d: 'M12 20c-5.5 0-10-2.5-10-6.5 0-1.5.5-3 1.5-4.5C2.5 7 3.5 4.5 5.5 4.5c1.5 0 2.5 1.2 3 2.5 1-.4 2.2-.5 3.5-.5s2.5.1 3.5.5c.5-1.3 1.5-2.5 3-2.5 2 0 3 2.5 2 4.5 1 1.5 1.5 3 1.5 4.5 0 4-4.5 6.5-10 6.5Z',
        key: 'head',
      },
    ],
    ['path', { d: 'M8 12.5h.01', key: 'eye-left' }],
    ['path', { d: 'M16 12.5h.01', key: 'eye-right' }],
    ['path', { d: 'M12 16h.01', key: 'nose' }],
  ],
});

export const iconSlots = {
  /** Sidebar "Search" (circle glyph) and the search field on the Search screen. */
  search: Search,
  /** Sidebar nav "Agents" (circle glyph). */
  agents: PawPrint,
  /** Sidebar nav "Canvases" (rounded-square glyph), plan canvas links. */
  canvases: FileText,
  /** The Audit log (square glyph); no longer a sidebar nav row (docs/decisions/settings-simplify.md SS-21). */
  auditLog: ScrollText,
  /** Channel rows and channel header (`#` in DM Mono). */
  channel: Hash,
  /** Branches: repositories, new repository (no sidebar section since SS-20). */
  branch: GitBranch,
  /** Pull request references (PR #482). */
  pullRequest: GitPullRequest,
  /** Commits card rows. */
  commit: GitCommitHorizontal,
  /** Direct messages with an agent. */
  directMessage: MessageCircle,
  /** Thread link / thread pane. */
  thread: MessagesSquare,
  /** Pane and modal close (`×`). */
  close: X,
  /** DM header back button (`←`). */
  back: ArrowLeft,
  /** Inline "go to" links (`Full audit trail →`, `Mobile app →`). */
  forward: ArrowRight,
  /** Links that leave the app (staging URL). */
  external: ArrowUpRight,
  /** Key the agent holds / condition met (`✓` on ok circle). */
  can: Check,
  /** Key that asks a person (`?` on warn circle). */
  ask: CircleQuestionMark,
  /** Key the agent does not hold (`×` on line2 circle); also failed checks (`✗`). */
  cannot: X,
  /** Keys that can never be granted to agents ("people only"). */
  locked: Lock,
  /** Keys / permissions. */
  key: KeyRound,
  /** “Use its screen”: the Whombat's own screen lets a device in (signin-at-box-web.md AP-3508). */
  screen: Monitor,
  /** Local, the model on your network, where Claude's and OpenAI's marks stand (hermes-engine-app.md AP-5044). */
  localModel: Server,
  /** Signed event / verified signature. */
  signed: ShieldCheck,
  /** A Feedback report's “Email verified” mark (the visitor signed in with the address). */
  emailVerified: MailCheck,
  /** Composer tool chip `@ agent`. */
  mention: AtSign,
  /** Composer tool chip `/ command`. */
  command: Slash,
  /** Composer tool chip `+ file`. */
  attach: Plus,
  /** Composer send. */
  send: ArrowUp,
  /** Theme toggle when the current theme is dark (switch to light). */
  themeLight: Sun,
  /** Theme toggle when the current theme is light (switch to dark). */
  themeDark: Moon,
  /** Audit log "Export CSV". */
  export: Download,
  /** Approval to deploy. */
  deploy: Rocket,
  /** Plan card. */
  plan: ListChecks,
  /** Run: resume / watch. */
  run: Play,
  /** Run: pause. */
  pause: Pause,
  /** Canvas edit. */
  edit: SquarePen,
  /** Canvas header "Share" (copies the canvas link). */
  share: Share2,
  /** People (the "People" filter). */
  people: Users,
  /** Mobile inbox tab. */
  inbox: Inbox,
  /** Notifications. */
  notifications: Bell,
  /** Settings / Configure agent. */
  settings: Settings,
  /** Overflow menu. */
  more: Ellipsis,
  /** Sidebar section `+` (create a channel). */
  add: Plus,
  /** Reading something again from where it comes from (Settings → Connections → GitHub: Sync repos). */
  refresh: RefreshCw,
  /** Attachment chips: a file, a PDF or text file, downloading one (docs/decisions/bp-attachments.md). */
  file: File,
  fileText: FileText,
  download: Download,
  /** Thread pane: “Open thread full width” and back to the pane (docs/decisions/ui-improvements.md AP-304). */
  expand: Maximize2,
  collapse: Minimize2,
  /**
   * A message's hover toolbar, leftmost: “Ask an agent” / “Ask Neo”, John's wombat (docs/decisions/ask-agent.md
   * AP-953, AP-954). Not `ask`: that slot is a key that asks a person.
   */
  askAgent: WombatFace,
  /** A message's hover toolbar: “Reply in thread” (AP-443). */
  reply: MessageSquareReply,
  /** Pinned messages: the marker, “Pinned · N” and the pins pane (AP-445); Unpin. */
  pin: Pin,
  unpin: PinOff,
  /** A deleted message's place (AP-442). */
  delete: Trash2,
  /** A menu that opens (search filters, AP-448). */
  chevronDown: ChevronDown,
  /** A thread read further up: “Scroll to the end” (docs/app/decisions/thread-scroll.md). */
  toEnd: ArrowDown,
  /** Files: the sidebar row, a conversation's folders (docs/decisions/files-space.md AP-772). */
  folder: Folder,
  /** A message's file: “Save to Files”, and “In Files” once it is there (docs/decisions/files-space.md AP-834). */
  folderPlus: FolderPlus,
  folderCheck: FolderCheck,
  /** Below 1024 px: the button that opens the sidebar drawer (docs/decisions/web-efficiency.md WE-15). */
  menu: Menu,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof iconSlots;
