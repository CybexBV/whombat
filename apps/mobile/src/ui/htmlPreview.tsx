/**
 * An agent's HTML page on mobile (assignment item 8, AP-328): a card with the page's title, “Open full screen” and
 * “View source”, and the live page in a `react-native-webview` confined like the web's sandboxed frame
 * (`data/richPreview.ts`: the frame's CSP as the page's first element, no storage, files, windows or navigation).
 * Also the code block every rich message uses (language label, Copy, the README's code colours).
 */
import { type DiagramTheme, mermaidDocumentWith, mermaidScriptElement } from '@whombat/client';
import { htmlTitle } from '@whombat/core';
import { fontFamilies, pageThemeCss } from '@whombat/tokens';
import mermaidRuntime from 'mermaid/dist/mermaid.min.js';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { AppState, ScrollView, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { COPIED_TEXT } from '../data/messageActions';
import { PAGES_COPY } from '../data/pageSets';
import { keepPageHeight, keptPage, keptPageHeight } from '../data/previewPages';
import {
  afterPreviewGone,
  PAGE_HEIGHT_SCRIPT,
  PREVIEW_STEADY_MS,
  PREVIEW_CARD_HEIGHT,
  PREVIEW_WEBVIEW_PROPS,
  pageHeight,
  withPreviewPolicy,
} from '../data/richPreview';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { copyToClipboard } from './clipboard';
import { FullScreenModal } from './fullScreen';
import { Check, Code2, Copy, Globe, type LucideIcon, Maximize2, Workflow, X } from './icons';
import { useRowInView } from './inView';
import { Button } from './primitives';
import { KeepsSideways } from './sideways';
import { Touchable } from './Touchable';
import { hitSlopFor } from './touchTarget';

/**
 * A code block: its language (or another label, “Diagram”; “Code” without one, as on the web) and Copy above the code,
 * on the code surface. Copy puts the code on the clipboard and says “Copied” for two seconds (MX-04, the web's AP-322).
 */
export function CodeBlockView({ label, text }: { label: string | null; text: string }) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const CopyIcon = copied ? Check : Copy;
  return (
    <View style={{ borderRadius: 10, backgroundColor: theme.colors.code, overflow: 'hidden' }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          paddingLeft: 12,
          paddingRight: 4,
          paddingTop: 4,
        }}
      >
        <Text size={11} mono color={theme.code.command} numberOfLines={1} style={{ flexShrink: 1 }}>
          {label?.trim() || 'Code'}
        </Text>
        <Touchable
          onPress={() => void copyToClipboard(text, COPIED_TEXT.code).then((ok) => ok && setCopied(true))}
          accessibilityLabel={copied ? 'Copied' : 'Copy the code'}
          feedback="fade"
          ringRadius={8}
          hitSlop={hitSlopFor(32)}
          style={{
            height: 32,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            paddingHorizontal: 8,
            borderRadius: 8,
          }}
        >
          <CopyIcon size={14} color={theme.code.command} strokeWidth={1.75} />
          <Text size={11} mono color={theme.code.command}>
            {copied ? 'Copied' : 'Copy'}
          </Text>
        </Touchable>
      </View>
      {/* A long line scrolls sideways here, not the message's swipe. */}
      <KeepsSideways>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
          <Text
            size={12.5}
            mono
            lh={1.55}
            color={theme.code.text}
            style={{ paddingHorizontal: 12, paddingTop: 2, paddingBottom: 9 }}
            selectable
          >
            {text}
          </Text>
        </ScrollView>
      </KeepsSideways>
    </View>
  );
}

/**
 * The live page. In a card (`fit`) it starts at the card's height and then takes the page's own height, which the page
 * reports through the WebView's one message (docs/decisions/visual-replies.md); full screen it fills the screen.
 */
function PreviewPage({ page, fit = false, pageKey }: { page: string; fit?: boolean; pageKey: string }) {
  const theme = useTheme();
  const source = useMemo(() => ({ html: page }), [page]);
  // The height the page last said it was, also from before its row left the list's window: it comes back at that size.
  const [height, setHeight] = useState(() => keptPageHeight(pageKey) ?? PREVIEW_CARD_HEIGHT);
  // In a chat row, the WebView starts when the row comes near the screen (AP-909): every page in the list's window ran
  // live before. Once it has been out of view a while it is let go again (each one is a browser's worth of memory), the
  // card keeping its height, as an unloaded page shows it.
  const inView = useRowInView();
  const [started, setStarted] = useState(inView);
  if (inView && !started) setStarted(true);
  useEffect(() => {
    if (inView || !started || !fit) return;
    const t = setTimeout(() => setStarted(false), PREVIEW_RELEASE_MS);
    return () => clearTimeout(t);
  }, [inView, started, fit]);
  // A WebView whose browser went leaves the page blank: a new WebView starts it again. Android letting it go for memory
  // only waits for the app to be in front; a crash restarts it twice by itself, then the person's “Try again”.
  const [mount, setMount] = useState(0);
  const [restarts, setRestarts] = useState(0);
  const [gone, setGone] = useState(false);
  const [asleep, setAsleep] = useState(false);
  const [loaded, setLoaded] = useState(0);
  const [shown, setShown] = useState(page);
  if (shown !== page) {
    setShown(page);
    setRestarts(0);
    setGone(false);
  }
  // Earlier crashes are forgotten once a load has stayed up a while: a page that crashes as it loads still stops.
  useEffect(() => {
    if (loaded === 0) return;
    const t = setTimeout(() => setRestarts(0), PREVIEW_STEADY_MS);
    return () => clearTimeout(t);
  }, [loaded]);
  useEffect(() => {
    if (!asleep) return;
    const wake = () => {
      setAsleep(false);
      setMount((n) => n + 1);
    };
    if (AppState.currentState === 'active') {
      wake();
      return;
    }
    const sub = AppState.addEventListener('change', (next) => next === 'active' && wake());
    return () => sub.remove();
  }, [asleep]);
  // iOS doesn't say why its page process ended: counted as a crash, so it can't loop.
  const onGone = (crashed: boolean) => {
    setLoaded(0);
    const next = afterPreviewGone(restarts, crashed);
    if (next === 'remount') setAsleep(true);
    else if (next === 'restart') {
      setRestarts((n) => n + 1);
      setMount((n) => n + 1);
    } else setGone(true);
  };
  if ((!started && fit) || asleep)
    return <View style={fit ? { height, backgroundColor: 'transparent' } : { flex: 1 }} />;
  if (gone)
    return (
      <View
        style={{
          // As tall as the card was, or as its words and button need when it was shorter.
          ...(fit ? { minHeight: height } : { flex: 1 }),
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          padding: 24,
        }}
      >
        <Text
          size={15}
          color={theme.colors.ink2}
          accessibilityLiveRegion="polite"
          style={{ textAlign: 'center' }}
        >
          {PREVIEW_GONE_TEXT}
        </Text>
        <Button
          label={PAGES_COPY.tryAgain}
          variant="secondary"
          onPress={() => {
            setRestarts(0);
            setMount((n) => n + 1);
            setGone(false);
          }}
        />
      </View>
    );
  // The page scrolls itself, sideways too, not the message's swipe; the chat scrolls around the card.
  return (
    <KeepsSideways>
      <WebView
        key={mount}
        {...PREVIEW_WEBVIEW_PROPS}
        source={source}
        onRenderProcessGone={(e) => onGone(e.nativeEvent.didCrash)}
        onContentProcessDidTerminate={() => onGone(true)}
        onLoad={() => setLoaded((n) => n + 1)}
        // Full screen the page's own background shows once it loads; until then the app's, not a white flash in dark.
        style={
          fit ? { height, backgroundColor: 'transparent' } : { flex: 1, backgroundColor: theme.colors.bg }
        }
        nestedScrollEnabled
        {...(fit
          ? {
              injectedJavaScript: PAGE_HEIGHT_SCRIPT,
              onMessage: (e: { nativeEvent: { data: string } }) => {
                const h = pageHeight(e.nativeEvent.data);
                if (h === null) return;
                setHeight(h);
                keepPageHeight(pageKey, h);
              },
            }
          : {})}
      />
    </KeepsSideways>
  );
}

/** Where a preview's browser stopped again and again: the page set viewer's words, for one page. */
const PREVIEW_GONE_TEXT = 'Couldn’t open this page.';

/** How long a page stays live after its row left the screen (and the two rows either side). */
const PREVIEW_RELEASE_MS = 20_000;

function HeaderButton({
  icon: Icon,
  label,
  onPress,
  selected,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  selected?: boolean;
}) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      feedback="wash"
      ringRadius={22}
      style={{
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: selected ? theme.colors.sf2 : 'transparent',
      }}
    >
      <Icon size={18} color={theme.colors.ink2} strokeWidth={1.75} />
    </Touchable>
  );
}

/** The card around a preview: title, actions, then the page or its source. */
function PreviewCard({
  icon,
  title,
  meta,
  source,
  sourceLabel,
  page,
  full,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  meta?: string;
  source: string;
  sourceLabel: string;
  /** The live page in the card. */
  page: ReactNode;
  /** The live page full screen. */
  full: (close: () => void) => ReactNode;
  /** More actions (an attachment's share). */
  actions?: ReactNode;
}) {
  const theme = useTheme();
  const [showSource, setShowSource] = useState(false);
  const [open, setOpen] = useState(false);
  const Icon = icon;
  return (
    <View
      accessibilityLabel={title}
      style={{
        width: '100%',
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingLeft: 12,
          paddingRight: 2,
          minHeight: 48,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.line,
        }}
      >
        <Icon size={16} color={theme.colors.mut} strokeWidth={1.75} />
        <View style={{ flex: 1 }}>
          <Text size={14} weight={600} numberOfLines={1}>
            {title}
          </Text>
          {meta ? (
            <Text size={11} mono color={theme.colors.mut} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
        <HeaderButton icon={Maximize2} label="Open full screen" onPress={() => setOpen(true)} />
        <HeaderButton
          icon={Code2}
          label="View source"
          selected={showSource}
          onPress={() => setShowSource((s) => !s)}
        />
        {actions}
      </View>
      {showSource ? (
        <View style={{ padding: 8 }}>
          <CodeBlockView label={sourceLabel} text={source} />
        </View>
      ) : (
        page
      )}
      {open ? (
        <FullScreenModal animationType="slide" onClose={() => setOpen(false)}>
          {full(() => setOpen(false))}
        </FullScreenModal>
      ) : null}
    </View>
  );
}

function FullScreenPage({
  page,
  pageKey,
  title,
  onClose,
}: {
  page: string;
  pageKey: string;
  title: string;
  onClose: () => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, minHeight: 56 }}
      >
        <Touchable
          onPress={onClose}
          accessibilityLabel="Close full screen"
          feedback="wash"
          ringRadius={22}
          style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }}
        >
          <X size={20} color={theme.colors.ink} strokeWidth={2} />
        </Touchable>
        <Text size={15} weight={600} numberOfLines={1} style={{ flex: 1 }} accessibilityRole="header">
          {title}
        </Text>
      </View>
      <PreviewPage page={page} pageKey={pageKey} />
    </View>
  );
}

/** An HTML page (a fenced block, a raw page, an `.html` attachment) as a live preview. */
export function HtmlPreviewCard({
  html,
  fallbackTitle,
  meta,
  actions,
}: {
  html: string;
  /** Without a `<title>`: the attachment's name, else “HTML page”. */
  fallbackTitle?: string;
  meta?: string;
  actions?: ReactNode;
}) {
  const title = useMemo(() => htmlTitle(html), [html]) ?? fallbackTitle ?? 'HTML page';
  const themeName = useTheme().name;
  // The app's theme as the page's first style: a new theme is a new page.
  const page = useMemo(() => withPreviewPolicy(html, pageThemeCss(themeName)), [html, themeName]);
  const pageKey = `html|${themeName}|${html}`;
  return (
    <PreviewCard
      icon={Globe}
      title={title}
      meta={meta ?? 'HTML page'}
      source={html}
      sourceLabel="html"
      page={<PreviewPage key={themeName} page={page} pageKey={pageKey} fit />}
      full={(close) => <FullScreenPage page={page} pageKey={pageKey} title={title} onClose={close} />}
      actions={actions}
    />
  );
}

/**
 * A Mermaid diagram on mobile (docs/decisions/visual-replies.md): drawn in the same confined WebView as a page, by the
 * Mermaid runtime bundled in the app, so drawing never needs a network request.
 */
export function DiagramPreview({
  source,
  title = 'Diagram',
  meta,
}: {
  source: string;
  title?: string;
  meta?: string;
}) {
  const theme = useTheme();
  const pageKey = `mermaid|${theme.name}|${source}`;
  // Each page carries the whole runtime (megabytes): made once per diagram and theme, kept for the next time its row
  // is drawn, and the runtime's element made once for all of them.
  const page = useMemo(() => {
    const colours: DiagramTheme = {
      dark: theme.dark,
      background: theme.colors.sf,
      node: theme.colors.sf2,
      text: theme.colors.ink,
      line: theme.colors.mut,
      accent: theme.colors.brand,
      secondary: theme.colors.bubble,
      font: fontFamilies.sans,
    };
    return keptPage(pageKey, () => withPreviewPolicy(mermaidDocumentWith(source, runtimeElement(), colours)));
  }, [pageKey, source, theme]);
  return (
    <PreviewCard
      icon={Workflow}
      title={title}
      meta={meta}
      source={source}
      sourceLabel="mermaid"
      page={<PreviewPage key={theme.name} page={page} pageKey={pageKey} fit />}
      full={(close) => <FullScreenPage page={page} pageKey={pageKey} title={title} onClose={close} />}
    />
  );
}

/** The Mermaid runtime's `<script>` element, its megabytes escaped once, on the first diagram (not at start). */
let runtimeTag: string | null = null;
function runtimeElement(): string {
  runtimeTag ??= mermaidScriptElement(mermaidRuntime);
  return runtimeTag;
}
