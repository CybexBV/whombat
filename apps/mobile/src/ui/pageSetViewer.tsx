/**
 * A page set full screen (docs/decisions/page-sets.md): its title (and the shown page's), Close, Back through the pages
 * you opened (Android's back button too, before it closes), and Download for the whole set; below, one page at a time in
 * a WebView confined as the HTML preview's (`data/richPreview.ts`). The WebView loads only the viewer's script under the
 * page policy; the script asks for the page and its files, which the app reads out of the set's file through the session
 * (`@whombat/client/pages`) and hands over as base64. Another page of the set is a new WebView.
 *
 * What a page asks for beyond its own files is never done by itself: a link out shows where it goes with Open, a link to
 * a file shows its name and size with Download (a copy in `cache/shared/<attachment id>/`, then the share sheet).
 */

import { PageSetHost, PageSetReader, pageTarget } from '@whombat/client/pages';
import { type ResourceRef, resourceFromUrl } from '@whombat/client/session';
import { type Attachment, PAGES_DEFAULT_OPEN, pageFileType, pageSetTitle } from '@whombat/core';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { FileAccess } from '../data/fileAccess';
import {
  entryDataAt,
  externalHost,
  externalLine,
  LOCAL_HEADER_BYTES,
  openedPage,
  openingPage,
  type PageAt,
  pageBefore,
  pageFileLine,
  pageSubtitle,
  pagesCopy,
  pagesInjection,
  pagesLoaderHtml,
  sessionReadRange,
  sharedCopyPath,
} from '../data/pageSets';
import { PREVIEW_WEBVIEW_PROPS } from '../data/richPreview';
import { useI18n, useMobileT } from '../i18n';
import { expoFileApi } from '../managed/expoFiles';
import { rangeToFile } from '../managed/files';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FullScreenModal } from './fullScreen';
import { ArrowLeft, Download, type LucideIcon, X } from './icons';
import { Button } from './primitives';
import { Touchable } from './Touchable';

/** A page that sends you on more often than this without showing anything is given up on. */
const MAX_REDIRECTS = 5;

/** What a link asked for that the viewer doesn't do by itself. */
type Notice =
  | { kind: 'file'; path: string; size: number }
  | { kind: 'external'; url: string; host: string }
  | { kind: 'missing' };

export function PageSetViewer({
  attachment,
  access,
  onClose,
  onDownload,
}: {
  attachment: Attachment;
  access: FileAccess;
  onClose: () => void;
  /** The whole set, the way a message's file is downloaded (the share sheet). */
  onDownload: () => Promise<void>;
}) {
  const theme = useTheme();
  const { rawLocale } = useI18n();
  const copy = pagesCopy(rawLocale);
  const title = pageSetTitle(attachment.name);
  const ref = useMemo(() => resourceFromUrl(attachment.url), [attachment.url]);
  const read = useMemo(() => (ref ? sessionReadRange(access.session, ref) : null), [access.session, ref]);
  const reader = useMemo(
    () => (read ? new PageSetReader(read, attachment.size) : null),
    [read, attachment.size],
  );
  // Try again shows the page again (a new WebView), or reads the set again when its first page never came.
  const [attempt, setAttempt] = useState(0);

  const [pages, setPages] = useState<PageAt[]>([]);
  const [phase, setPhase] = useState<'opening' | 'shown' | 'failed'>('opening');
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Whether the current page was shown: a page that asks for another before it is shown sends you on.
  const shown = useRef(false);
  const redirects = useRef(0);
  const current = pages.at(-1) ?? null;

  // The first page: the one the set names (a folder's index page), else its index.html. A read that failed is read again
  // next time (the reader keeps nothing that failed).
  const opening = useRef(0);
  const begin = useCallback(() => {
    const run = ++opening.current;
    const live = () => run === opening.current;
    if (!reader) {
      setPhase('failed');
      return;
    }
    setPhase('opening');
    (async () => {
      const first = openingPage(await reader.manifest());
      let target = await pageTarget(reader, first);
      if (target.kind !== 'page' && first !== PAGES_DEFAULT_OPEN)
        target = await pageTarget(reader, PAGES_DEFAULT_OPEN);
      if (!live()) return;
      if (target.kind !== 'page') setPhase('failed');
      else setPages([{ path: target.path, hash: target.hash }]);
    })().catch(() => {
      if (live()) setPhase('failed');
    });
  }, [reader]);
  useEffect(() => {
    begin();
    return () => {
      opening.current += 1;
    };
  }, [begin]);

  const show = (next: SetStateAction<PageAt[]>) => {
    shown.current = false;
    setNotice(null);
    setPageTitle(null);
    setPhase('opening');
    setPages(next);
  };

  const onOpen = (path: string, hash: string, query = '') => {
    if (!reader || !current) return;
    pageTarget(reader, path, hash).then(
      (target) => {
        if (target.kind === 'file') setNotice({ kind: 'file', path: target.path, size: target.size });
        else if (target.kind === 'missing') setNotice({ kind: 'missing' });
        else if (target.path !== current.path || query !== (current.query ?? '')) {
          const redirect = !shown.current;
          if (redirect && ++redirects.current > MAX_REDIRECTS) {
            setPhase('failed');
            return;
          }
          show((p) => openedPage(p, { path: target.path, hash: target.hash, query }, redirect));
        }
      },
      () => setNotice({ kind: 'missing' }),
    );
  };
  const onExternal = (url: string) => {
    const host = externalHost(url);
    if (host) setNotice({ kind: 'external', url, host });
  };
  const onShown = (path: string, titleOfPage: string) => {
    if (path !== current?.path) return;
    shown.current = true;
    redirects.current = 0;
    setPageTitle(titleOfPage);
    setPhase('shown');
  };
  const onFailed = (path: string) => {
    if (path === current?.path) setPhase('failed');
  };

  const back = () => {
    const before = pageBefore(pages);
    if (before) show(before);
    else onClose();
  };
  const tryAgain = () => {
    shown.current = false;
    redirects.current = 0;
    setPhase('opening');
    if (current) setAttempt((n) => n + 1);
    else begin();
  };

  const [downloading, setDownloading] = useState(false);
  const download = () => {
    if (downloading) return;
    setDownloading(true);
    onDownload()
      .catch(() => {})
      .finally(() => setDownloading(false));
  };

  const subtitle = phase === 'shown' ? pageSubtitle(title, pageTitle) : null;
  return (
    <FullScreenModal animationType="slide" onClose={back}>
      <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            paddingHorizontal: 8,
            minHeight: 56,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.line,
          }}
        >
          <HeaderButton icon={X} label={copy.close} onPress={onClose} />
          {pages.length > 1 ? <HeaderButton icon={ArrowLeft} label={copy.back} onPress={back} /> : null}
          <View style={{ flex: 1, paddingHorizontal: 4 }} accessible accessibilityRole="header">
            <Text size={15} weight={600} numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text size={12} color={theme.colors.mut} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          <HeaderButton
            icon={Download}
            label={`${copy.download} ${attachment.name}`}
            onPress={download}
            busy={downloading}
          />
        </View>
        <View style={{ flex: 1 }}>
          {reader && current ? (
            // Under the cover until it is shown: not read out either.
            <View
              style={{ flex: 1 }}
              importantForAccessibility={phase === 'shown' ? 'auto' : 'no-hide-descendants'}
              accessibilityElementsHidden={phase !== 'shown'}
            >
              <PageFrame
                key={`${pages.length}|${current.path}|${current.query ?? ''}|${attempt}`}
                reader={reader}
                page={current}
                onOpen={onOpen}
                onExternal={onExternal}
                onShown={onShown}
                onFailed={onFailed}
              />
            </View>
          ) : null}
          {phase !== 'shown' ? <Cover failed={phase === 'failed'} onTryAgain={tryAgain} /> : null}
        </View>
        {notice && reader && read && ref ? (
          <NoticeBar
            notice={notice}
            download={(path) => shareSetFile(attachment.id, reader, read, access, ref, path, rawLocale)}
          />
        ) : null}
      </View>
    </FullScreenModal>
  );
}

/**
 * One page of the set in its WebView: the viewer's script under the page policy, answered by a host of its own (a page
 * left for another gets no more answers; its asks would land in the next page's numbering).
 */
function PageFrame({
  reader,
  page,
  ...on
}: {
  reader: PageSetReader;
  page: PageAt;
  onOpen: (path: string, hash: string, query: string) => void;
  onExternal: (url: string) => void;
  onShown: (path: string, title: string) => void;
  onFailed: (path: string) => void;
}) {
  const theme = useTheme();
  const web = useRef<WebView>(null);
  const host = useRef<PageSetHost | null>(null);
  // The viewer's handlers change with every render; the host calls the latest.
  const handlers = useRef(on);
  handlers.current = on;
  useEffect(() => {
    const h = new PageSetHost(reader, (m) => web.current?.injectJavaScript(pagesInjection(m)), 'base64');
    h.onOpen = (path, hash, query) => handlers.current.onOpen(path, hash, query);
    h.onExternal = (url) => handlers.current.onExternal(url);
    h.onShown = (path, title) => handlers.current.onShown(path, title);
    h.onFailed = (path) => handlers.current.onFailed(path);
    host.current = h;
    return () => {
      h.close();
      if (host.current === h) host.current = null;
    };
  }, [reader]);
  const source = useMemo(() => ({ html: pagesLoaderHtml() }), []);
  const failed = useCallback(() => handlers.current.onFailed(page.path), [page.path]);
  return (
    <WebView
      ref={web}
      {...PREVIEW_WEBVIEW_PROPS}
      source={source}
      onMessage={(e) => host.current?.handle(e.nativeEvent.data, page)}
      onError={failed}
      onRenderProcessGone={failed}
      onContentProcessDidTerminate={failed}
      // The page's own background shows once it is written; until then the app's, not a white flash in dark.
      style={{ flex: 1, backgroundColor: theme.colors.bg }}
    />
  );
}

/** Over the page until it is shown: Opening…, or why not with Try again. */
function Cover({ failed, onTryAgain }: { failed: boolean; onTryAgain: () => void }) {
  const theme = useTheme();
  const { rawLocale } = useI18n();
  const copy = pagesCopy(rawLocale);
  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        padding: 24,
        backgroundColor: theme.colors.bg,
      }}
    >
      {failed ? (
        <>
          <Text
            size={15}
            color={theme.colors.ink2}
            accessibilityLiveRegion="polite"
            style={{ textAlign: 'center' }}
          >
            {copy.failed}
          </Text>
          <Button label={copy.tryAgain} variant="secondary" onPress={onTryAgain} />
        </>
      ) : (
        <>
          <ActivityIndicator color={theme.colors.mut} />
          <Text size={13} color={theme.colors.mut} accessibilityLiveRegion="polite">
            {copy.opening}
          </Text>
        </>
      )}
    </View>
  );
}

/** Under the page: what a link asked for, with the one thing to do about it. */
function NoticeBar({ notice, download }: { notice: Notice; download: (path: string) => Promise<void> }) {
  const { t: tMobile } = useMobileT();
  const { rawLocale } = useI18n();
  const copy = pagesCopy(rawLocale);
  const theme = useTheme();
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  // A new notice starts afresh.
  const key = notice.kind === 'file' ? notice.path : notice.kind === 'external' ? notice.url : '';
  const [shownFor, setShownFor] = useState(key);
  if (shownFor !== key) {
    setShownFor(key);
    setState('idle');
  }
  const line =
    notice.kind === 'file'
      ? pageFileLine(notice.path, notice.size)
      : notice.kind === 'external'
        ? externalLine(notice.host, rawLocale)
        : copy.missing;
  const save = () => {
    if (notice.kind !== 'file' || state === 'busy') return;
    setState('busy');
    download(notice.path).then(
      () => setState('idle'),
      () => setState('failed'),
    );
  };
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 60,
        paddingVertical: 8,
        paddingLeft: 16,
        paddingRight: 12,
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
      }}
    >
      <View style={{ flex: 1 }} accessible accessibilityLiveRegion="polite">
        <Text size={14} numberOfLines={2}>
          {line}
        </Text>
        {state === 'failed' ? (
          <Text size={11} mono color={theme.colors.bad}>
            {tMobile('ui.couldnt-open-it-tap-to-try-again')}
          </Text>
        ) : null}
      </View>
      {notice.kind === 'file' ? (
        <Button
          label={copy.download}
          variant="secondary"
          busy={state === 'busy'}
          onPress={save}
          accessibilityLabel={`${copy.download} ${line}`}
          style={{ paddingHorizontal: 16 }}
        />
      ) : notice.kind === 'external' ? (
        <Button
          label={copy.open}
          variant="secondary"
          onPress={() => void Linking.openURL(notice.url).catch(() => {})}
          accessibilityLabel={`${copy.open} ${notice.host}`}
          style={{ paddingHorizontal: 16 }}
        />
      ) : null}
    </View>
  );
}

function HeaderButton({
  icon: Icon,
  label,
  onPress,
  busy = false,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  busy?: boolean;
}) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityState={{ busy }}
      feedback="wash"
      ringRadius={22}
      style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }}
    >
      {busy ? (
        <ActivityIndicator color={theme.colors.ink} />
      ) : (
        <Icon size={20} color={theme.colors.ink} strokeWidth={Icon === X ? 2 : 1.75} />
      )}
    </Touchable>
  );
}

/**
 * One file of the set through the share sheet: its bytes streamed from where they lie in the set's file into
 * `cache/shared/<attachment id>/<name>` (bp-attachments.md BP-A19, BP-A21), never whole in memory.
 */
async function shareSetFile(
  attachmentId: string,
  reader: PageSetReader,
  read: ReturnType<typeof sessionReadRange>,
  access: FileAccess,
  ref: ResourceRef,
  path: string,
  locale: string,
): Promise<void> {
  const entry = (await reader.entries()).get(path);
  if (!entry) throw new Error('not in the set');
  const dataAt = entryDataAt(
    entry,
    await read({ start: entry.offset, end: entry.offset + LOCAL_HEADER_BYTES }),
  );
  if (dataAt === null) throw new Error('not an entry');
  const { dir, name } = sharedCopyPath(attachmentId, path);
  // expo-file-system makes the URIs, so a name with spaces or accents is encoded as each platform reads it.
  const folder = new Directory(Paths.cache, ...dir);
  const uri = await rangeToFile(
    expoFileApi,
    access.session,
    ref,
    { start: dataAt, end: dataAt + entry.size },
    { dir: folder.uri, target: new File(folder, name).uri, locale },
  );
  await Sharing.shareAsync(uri, { mimeType: pageFileType(path), dialogTitle: name });
}
