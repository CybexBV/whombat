/**
 * A guide card in the personal assistant's DM (docs/decisions/assistant-guides.md AG-02, AG-15, AG-17), whole:
 * the card shell of the other chat cards (sf, 1.5dp line border, radius 16), the mono label row, title, body and
 * its blocks — choices as tiles, buttons, copy rows, links, status rows, a secure form and, instead of Google
 * sign-in on the phone, a button that opens the DM on the web (SUB-11). Locked cards show the quiet answer row.
 */

import type { GuideActInput } from '@whombat/client';
import { problemText, vaultAskOf } from '@whombat/client';
import { cardOAuthStartBody, connectFormText, connectProblem } from '@whombat/client/connections';
import {
  useConnectionWrite,
  useStartGoogleConnection,
  useStartMicrosoftConnection,
} from '@whombat/client/react';
import type {
  GuideAction,
  GuideActionsBlock,
  GuideBlock,
  GuideCard,
  GuideChoicesBlock,
  GuideConnectBlock,
  GuideConnectOAuth,
  GuideCopyBlock,
  GuideFormBlock,
  GuideIcon,
  GuideLinksBlock,
  GuideOption,
  GuideStatusBlock,
  GuideStatusState,
  GuideVaultAsk,
} from '@whombat/core';
import { api, GUIDE_VALUE_MAX } from '@whombat/core/contracts';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useEffect, useRef, useState } from 'react';
import { Clipboard, Linking, Share, TextInput, View } from 'react-native';
import { useBurrow } from '../data/BurrowProvider';
import {
  applyClientFile,
  connectAppLabel,
  connectLabel,
  connectNote,
  connectStartProblem,
  connectWebUrl,
  formValues,
  type GuideWeb,
  guideAppUrl,
  guideHrefUrl,
  guideText,
  guideView,
  missingFields,
  toggleOption,
} from '../data/guides';
import { mobileTranslator, useI18n, useMobileT } from '../i18n';
import { holdPhoneConnect } from '../managed/connectReturn';
import { useManaged } from '../managed/context';
import { openAppUrl } from '../navigation/hooks';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';
import { BrandMark } from './BrandMark';
import {
  ArrowUpRight,
  Bell,
  Calendar,
  Check,
  CircleHelp,
  Clock,
  Copy as CopyIcon,
  FileText,
  Folder,
  Key,
  LinkIcon,
  type LucideIcon,
  Mail,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  UserPlus,
} from './icons';
import { Button, StatusDot, toneColor } from './primitives';
import { Touchable } from './Touchable';
import { VaultAskForm } from './vaultAsk';

/** What an act came to: `ok`, or not (the card is back as it was), with a form's field errors by id. */
export interface GuideActOutcome {
  ok: boolean;
  fields?: Record<string, string>;
}

export interface GuideCardViewProps {
  card: GuideCard;
  onAct: (input: GuideActInput) => Promise<GuideActOutcome>;
  /** Where paths on this Whombat open (the web); no web in the demo world. */
  web: GuideWeb;
}

const ICONS: Record<string, LucideIcon> = {
  mail: Mail,
  calendar: Calendar,
  folder: Folder,
  'file-text': FileText,
  sun: Sun,
  clock: Clock,
  sparkles: Sparkles,
  key: Key,
  link: LinkIcon,
  'shield-check': ShieldCheck,
  'circle-help': CircleHelp,
  'user-plus': UserPlus,
  bell: Bell,
  settings: Settings,
};

/** What a status dot means, for TalkBack. */
function statusWords(locale?: string | null): Record<GuideStatusState, string> {
  const tr = mobileTranslator(locale);
  return {
    ok: tr.t('screens2.guide.ok'),
    warn: tr.t('screens2.guide.warn'),
    bad: tr.t('screens2.guide.bad'),
    mut: tr.t('screens2.guide.mut'),
  };
}

function openUrl(url: string) {
  void Linking.openURL(url).catch(() => {});
}

export function GuideCardView({ card, onAct, web }: GuideCardViewProps) {
  const theme = useTheme();
  const { rawLocale } = useI18n();
  const view = guideView(card, rawLocale);
  const ask = vaultAskOf(card);
  // One act at a time: the card locks at once (optimistically), this covers the moment before.
  const [sending, setSending] = useState(false);
  const act = async (input: GuideActInput): Promise<GuideActOutcome> => {
    if (sending) return { ok: false };
    setSending(true);
    try {
      return await onAct(input);
    } finally {
      setSending(false);
    }
  };
  const blocks = view.blocks.map((block, i) => (
    <GuideBlockView
      // biome-ignore lint/suspicious/noArrayIndexKey: a card's blocks are positional and never reorder
      key={`${block.type}-${i}`}
      block={block}
      locked={view.locked}
      chosen={view.chosen}
      act={act}
      busy={sending}
      web={web}
      ask={ask}
      connectOAuth={card.connectOAuth}
    />
  ));
  return (
    <View
      accessibilityLabel={`${view.label}, ${view.title}`}
      style={{
        alignSelf: 'stretch',
        gap: 14,
        borderRadius: 16,
        borderWidth: 1.5,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        paddingVertical: 16,
        paddingHorizontal: 16,
      }}
    >
      <View style={{ gap: 6 }}>
        <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
          {view.label}
        </Text>
        <Text size={17} weight={600} lh={1.3} accessibilityRole="header">
          {view.title}
        </Text>
        {view.paragraphs.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are positional and never reorder
          <Text key={i} size={14.5} lh={1.45} color={theme.colors.ink2} style={{ marginTop: 2 }}>
            {p}
          </Text>
        ))}
      </View>
      {blocks}
      {view.locked && view.answer ? (
        <View
          accessible
          accessibilityLiveRegion="polite"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
        >
          {card.answer ? (
            <Check size={16} color={theme.colors.mut} strokeWidth={2} />
          ) : (
            <Clock size={16} color={theme.colors.mut} strokeWidth={2} />
          )}
          <Text size={13.5} lh={1.4} color={theme.colors.mut} style={{ flex: 1 }}>
            {view.answer}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function GuideBlockView({
  block,
  locked,
  chosen,
  act,
  busy,
  web,
  ask,
  connectOAuth,
}: {
  block: GuideBlock;
  locked: boolean;
  chosen: readonly string[];
  act: (input: GuideActInput) => Promise<GuideActOutcome>;
  busy: boolean;
  web: GuideWeb;
  /** A sign-in card's ask (`vault_ask`): its form is the sign-in form. */
  ask: GuideVaultAsk | null;
  /** Direct OAuth start details on an `add_connection` card. */
  connectOAuth: GuideConnectOAuth | undefined;
}) {
  switch (block.type) {
    case 'choices':
      return <ChoicesBlock block={block} locked={locked} chosen={chosen} act={act} busy={busy} />;
    case 'actions':
      return locked ? null : (
        <ActionsBlock block={block} act={act} busy={busy} web={web} connectOAuth={connectOAuth} />
      );
    case 'copy':
      return <CopyBlock block={block} />;
    case 'links':
      return <LinksBlock block={block} />;
    case 'status':
      return <StatusBlock block={block} web={web} />;
    case 'form':
      // Always mounted, hidden once locked: the optimistic lock and a refusal's rollback reach this view a tick
      // apart, and the form has to come back with what was typed and the server's words under its fields.
      return (
        <View style={locked ? { display: 'none' } : undefined}>
          {ask ? (
            <VaultAskForm ask={ask} block={block} act={act} busy={busy} />
          ) : (
            <FormBlock block={block} act={act} busy={busy} />
          )}
        </View>
      );
    case 'connect':
      return locked ? null : <ConnectBlock block={block} web={web} />;
    default:
      return null;
  }
}

/* Choices -------------------------------------------------------------------------------------------- */

function OptionIcon({ icon }: { icon: GuideIcon | null }) {
  const theme = useTheme();
  if (!icon) return null;
  if ('brand' in icon) return <BrandMark mark={icon.brand} size={24} />;
  const Icon = ICONS[icon.icon];
  return Icon ? <Icon size={24} color={theme.colors.ink} strokeWidth={1.75} /> : null;
}

function ChoicesBlock({
  block,
  locked,
  chosen,
  act,
  busy,
}: {
  block: GuideChoicesBlock;
  locked: boolean;
  chosen: readonly string[];
  act: (input: GuideActInput) => Promise<GuideActOutcome>;
  busy: boolean;
}) {
  const { tClient } = useI18n();
  const [ticked, setTicked] = useState<string[]>([]);
  const multi = block.mode === 'multi';
  const selected = locked ? chosen : ticked;
  return (
    <View style={{ gap: 8 }}>
      {block.options.map((option) => (
        <OptionTile
          key={option.id}
          option={option}
          multi={multi}
          locked={locked}
          selected={selected.includes(option.id)}
          busy={busy}
          onPress={() => {
            if (multi) setTicked((t) => toggleOption(t, option.id));
            else void act({ actionId: block.id, optionIds: [option.id] });
          }}
        />
      ))}
      {multi && !locked ? (
        <Button
          label={block.submitLabel ?? tClient('connectAi.continue')}
          disabled={ticked.length === 0}
          busy={busy}
          onPress={() => void act({ actionId: block.id, optionIds: ticked })}
        />
      ) : null}
    </View>
  );
}

function OptionTile({
  option,
  multi,
  locked,
  selected,
  busy,
  onPress,
}: {
  option: GuideOption;
  multi: boolean;
  locked: boolean;
  selected: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const green = theme.faces.banjo.accent;
  const dimmed = option.disabled || (locked && !selected);
  const badgeColor = option.badge ? toneColor(theme, option.badge.tone) : theme.colors.mut;
  const content = (
    <>
      <OptionIcon icon={option.icon} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text size={15} weight={600} lh={1.3}>
          {option.title}
        </Text>
        {option.description ? (
          <Text size={13.5} lh={1.42} color={theme.colors.ink2}>
            {option.description}
          </Text>
        ) : null}
        {option.badge ? (
          <View
            style={{
              alignSelf: 'flex-start',
              marginTop: 3,
              paddingHorizontal: 7,
              paddingVertical: 2,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: badgeColor,
            }}
          >
            <Text size={10.5} weight={500} mono tracking={0.04} uppercase color={badgeColor}>
              {option.badge.label}
            </Text>
          </View>
        ) : null}
      </View>
      {multi && !locked ? (
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            borderWidth: 1.5,
            borderColor: selected ? green : theme.colors.line2,
            backgroundColor: selected ? green : 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {selected ? <Check size={15} color={theme.colors.onSolid} strokeWidth={2.5} /> : null}
        </View>
      ) : selected ? (
        <Check size={20} color={green} strokeWidth={2.25} />
      ) : null}
    </>
  );
  const style = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
    minHeight: 56,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: selected ? green : theme.colors.line2,
    backgroundColor: theme.colors.bg,
    opacity: dimmed ? 0.55 : 1,
  };
  const label = [option.title, option.description, option.badge?.label].filter(Boolean).join(', ');
  if (locked)
    return (
      <View
        style={style}
        accessible
        accessibilityLabel={label}
        accessibilityState={{ selected, disabled: true }}
      >
        {content}
      </View>
    );
  return (
    <Touchable
      onPress={onPress}
      disabled={option.disabled || busy}
      feedback="wash"
      ringRadius={12}
      accessibilityRole={multi ? 'checkbox' : 'button'}
      accessibilityLabel={label}
      accessibilityState={multi ? { checked: selected, disabled: option.disabled || busy } : undefined}
      style={style}
    >
      {content}
    </Touchable>
  );
}

/* Buttons --------------------------------------------------------------------------------------------- */

function ActionButton({
  action,
  act,
  busy,
  web,
}: {
  action: GuideAction;
  act: (input: GuideActInput) => Promise<GuideActOutcome>;
  busy: boolean;
  web: GuideWeb;
}) {
  if (action.href) {
    // A link: opens (a page, or this Whombat on the web) and sends nothing. Add a server opens the app's own screen,
    // filled in (AP-1704); the web only if the app can't open it.
    const href = action.href;
    const app = guideAppUrl(href);
    if (app)
      return (
        <Button
          label={action.label}
          variant={action.style}
          onPress={() => {
            if (openAppUrl(app)) return;
            const url = guideHrefUrl(web, href);
            if (url) openUrl(url);
          }}
        />
      );
    const url = guideHrefUrl(web, href);
    if (!url) return null;
    return (
      <Button
        label={action.label}
        variant={action.style}
        accessibilityHint={url}
        onPress={() => openUrl(url)}
      />
    );
  }
  return (
    <Button
      label={action.label}
      variant={action.style}
      disabled={busy}
      onPress={() => void act({ actionId: action.id })}
    />
  );
}

function ConnectOAuthActionButton({
  action,
  oauth,
  busy,
  onProblem,
}: {
  action: GuideAction;
  oauth: GuideConnectOAuth;
  busy: boolean;
  onProblem: (text: string | null) => void;
}) {
  const { rawLocale } = useI18n();
  const connectFormTextHere = connectFormText(rawLocale);

  const managed = useManaged();
  const { slug } = useBurrow();
  const startOAuth = useConnectionWrite(api.connections.startOAuth, slug);

  async function start() {
    if (!managed) return;
    onProblem(null);
    holdPhoneConnect({ device: managed.applianceId, flow: 'connection' });
    try {
      const result = await startOAuth.mutateAsync({
        params: { burrow: slug },
        body: cardOAuthStartBody(oauth),
      });
      if (result.status !== 'ok') {
        onProblem(connectFormTextHere.notThrough);
        return;
      }
      openUrl(result.data.authorizeUrl);
    } catch (err) {
      onProblem(
        connectProblem(err, undefined, undefined, rawLocale).message ??
          problemText(err, connectFormTextHere.cantStart, rawLocale),
      );
    }
  }

  return (
    <Button
      label={action.label}
      variant={action.style}
      disabled={busy}
      busy={startOAuth.isPending}
      onPress={() => void start()}
    />
  );
}

function ActionsBlock({
  block,
  act,
  busy,
  web,
  connectOAuth,
}: {
  block: GuideActionsBlock;
  act: (input: GuideActInput) => Promise<GuideActOutcome>;
  busy: boolean;
  web: GuideWeb;
  connectOAuth: GuideConnectOAuth | undefined;
}) {
  const theme = useTheme();
  const managed = useManaged();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <View style={{ gap: 8 }}>
      {block.actions.map((action) =>
        connectOAuth && managed && (action.id === 'connect' || action.id === 'allow') ? (
          <ConnectOAuthActionButton
            key={action.id}
            action={action}
            oauth={connectOAuth}
            busy={busy}
            onProblem={setProblem}
          />
        ) : (
          <ActionButton key={action.id} action={action} act={act} busy={busy} web={web} />
        ),
      )}
      {problem ? (
        <Text size={13} lh={1.4} color={theme.colors.bad} accessibilityLiveRegion="polite">
          {problem}
        </Text>
      ) : null}
    </View>
  );
}

/* Copy rows ------------------------------------------------------------------------------------------- */

function CopyRow({ label, value }: { label: string; value: string }) {
  const { t: tMobile } = useMobileT();
  const { rawLocale } = useI18n();
  const words = guideText(rawLocale);
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = () => {
    try {
      Clipboard.setString(value);
    } catch {
      // No clipboard module: the share sheet (it offers Copy).
      void Share.share({ message: value }).catch(() => {});
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };
  return (
    <View style={{ gap: 6 }}>
      <Text size={12.5} weight={500} color={theme.colors.ink2}>
        {label}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'stretch', gap: 8 }}>
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            paddingVertical: 10,
            paddingHorizontal: 12,
            borderRadius: 10,
            backgroundColor: theme.colors.sf2,
          }}
        >
          <Text size={13} mono lh={1.4} selectable>
            {value}
          </Text>
        </View>
        <Touchable
          onPress={copy}
          feedback="wash"
          ringRadius={10}
          accessibilityLabel={tMobile(copied ? 'screens2.guide.copied' : 'screens2.guide.copy', { label })}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            minHeight: 44,
            minWidth: 44,
            paddingHorizontal: 12,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: theme.colors.line2,
          }}
        >
          {copied ? (
            <Check size={16} color={theme.faces.banjo.accent} strokeWidth={2.25} />
          ) : (
            <CopyIcon size={16} color={theme.colors.ink2} strokeWidth={1.75} />
          )}
          <Text size={14} weight={500} accessibilityLiveRegion="polite">
            {copied ? words.copied : words.copy}
          </Text>
        </Touchable>
      </View>
    </View>
  );
}

function CopyBlock({ block }: { block: GuideCopyBlock }) {
  return (
    <View style={{ gap: 12 }}>
      {block.rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder
        <CopyRow key={i} label={row.label} value={row.value} />
      ))}
    </View>
  );
}

/* Links and status ------------------------------------------------------------------------------------ */

function LinksBlock({ block }: { block: GuideLinksBlock }) {
  const theme = useTheme();
  return (
    <View>
      {block.links.map((link, i) => (
        <Touchable
          // biome-ignore lint/suspicious/noArrayIndexKey: links are positional and never reorder
          key={i}
          onPress={() => openUrl(link.url)}
          feedback="wash"
          accessibilityRole="link"
          accessibilityLabel={link.label}
          accessibilityHint={link.url}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            minHeight: 44,
            paddingVertical: 8,
            borderTopWidth: i === 0 ? 0 : 1,
            borderTopColor: theme.colors.line,
          }}
        >
          <Text size={15} weight={500} color={theme.colors.brand} style={{ flex: 1 }}>
            {link.label}
          </Text>
          <ArrowUpRight size={16} color={theme.colors.mut} strokeWidth={2} />
        </Touchable>
      ))}
    </View>
  );
}

function StatusBlock({ block, web }: { block: GuideStatusBlock; web: GuideWeb }) {
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const colors: Record<GuideStatusState, string> = {
    ok: theme.colors.ok,
    warn: theme.colors.warn,
    bad: theme.colors.bad,
    mut: theme.colors.mut,
  };
  return (
    <View>
      {block.rows.map((row, i) => {
        const url = row.href ? guideHrefUrl(web, row.href) : null;
        const body = (
          <>
            <StatusDot color={colors[row.state]} label={statusWords(rawLocale)[row.state]} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text size={14.5} weight={500} lh={1.35}>
                {row.label}
              </Text>
              {row.detail ? (
                <Text size={13} lh={1.42} color={theme.colors.ink2}>
                  {row.detail}
                </Text>
              ) : null}
            </View>
            {url ? <ArrowUpRight size={16} color={theme.colors.mut} strokeWidth={2} /> : null}
          </>
        );
        const style = {
          flexDirection: 'row' as const,
          alignItems: 'center' as const,
          gap: 10,
          paddingVertical: 10,
          borderTopWidth: i === 0 ? 0 : 1,
          borderTopColor: theme.colors.line,
        };
        return url ? (
          <Touchable
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder
            key={i}
            onPress={() => openUrl(url)}
            feedback="wash"
            accessibilityRole="link"
            accessibilityLabel={[row.label, statusWords(rawLocale)[row.state], row.detail]
              .filter(Boolean)
              .join(', ')}
            accessibilityHint={url}
            style={{ ...style, minHeight: 44 }}
          >
            {body}
          </Touchable>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder
          <View key={i} style={style}>
            {body}
          </View>
        );
      })}
    </View>
  );
}

/* The secure form ------------------------------------------------------------------------------------- */

/** Google's client_secret JSON through the system's document picker, read as text and deleted at once. */
async function pickJsonFile(): Promise<{ name: string; text: string | null } | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/json', 'text/plain', '*/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  const asset = result.canceled ? null : result.assets[0];
  if (!asset) return null;
  const file = new File(asset.uri);
  try {
    // Far bigger than any client file: not read at all.
    if ((asset.size ?? 0) > GUIDE_VALUE_MAX) return { name: asset.name, text: null };
    return { name: asset.name, text: await file.text() };
  } finally {
    // The picker's cache copy goes at once: the secret never stays on the phone.
    try {
      file.delete();
    } catch {
      // already gone
    }
  }
}

function FieldError({ text }: { text: string | undefined }) {
  const theme = useTheme();
  if (!text) return null;
  return (
    <Text size={12.5} lh={1.4} color={theme.colors.bad} accessibilityLiveRegion="polite">
      {text}
    </Text>
  );
}

function FormBlock({
  block,
  act,
  busy,
}: {
  block: GuideFormBlock;
  act: (input: GuideActInput) => Promise<GuideActOutcome>;
  busy: boolean;
}) {
  const theme = useTheme();
  const { rawLocale } = useI18n();
  const words = guideText(rawLocale);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, string>>({});
  const input = textMetrics({ size: 15 });
  const set = (id: string, value: string) => {
    setValues((v) => ({ ...v, [id]: value }));
    setErrors(({ [id]: _, ...rest }) => rest);
  };
  const choose = async (id: string) => {
    let picked: { name: string; text: string | null } | null;
    try {
      picked = await pickJsonFile();
    } catch {
      setErrors((e) => ({ ...e, [id]: words.fileUnreadable }));
      return;
    }
    if (!picked) return;
    const applied =
      picked.text === null
        ? { values: {}, error: words.fileTooBig }
        : applyClientFile(block.fields, id, picked.text, rawLocale);
    const { name } = picked;
    if (applied.error) {
      setErrors((e) => ({ ...e, [id]: applied.error ?? '' }));
      setFiles(({ [id]: _, ...rest }) => rest);
      setValues(({ [id]: _, ...rest }) => rest);
      return;
    }
    setValues((v) => ({ ...v, ...applied.values }));
    setFiles((f) => ({ ...f, [id]: name }));
    setErrors((e) => {
      const next = { ...e };
      for (const key of Object.keys(applied.values)) delete next[key];
      return next;
    });
  };
  const submit = async () => {
    const missing = missingFields(block.fields, values, rawLocale);
    if (Object.keys(missing).length) {
      setErrors(missing);
      return;
    }
    const outcome = await act({ actionId: block.id, values: formValues(block.fields, values) });
    if (outcome.ok) {
      // The values went to this Whombat only; nothing keeps them on the phone.
      setValues({});
      setFiles({});
      setErrors({});
    } else if (outcome.fields) setErrors(outcome.fields);
  };
  return (
    <View style={{ gap: 14 }}>
      {block.fields.map((field) => (
        <View key={field.id} style={{ gap: 6 }}>
          <Text size={13} weight={500} color={theme.colors.ink2}>
            {field.optional ? `${field.label} (optional)` : field.label}
          </Text>
          {field.kind === 'json_file' ? (
            <Touchable
              onPress={() => void choose(field.id)}
              disabled={busy}
              feedback="wash"
              ringRadius={10}
              accessibilityLabel={`${words.chooseFile}, ${field.label}`}
              accessibilityHint={files[field.id]}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                minHeight: 44,
                paddingHorizontal: 12,
                borderRadius: 10,
                borderWidth: 1,
                borderStyle: 'dashed',
                borderColor: errors[field.id] ? theme.colors.bad : theme.colors.line2,
              }}
            >
              <FileText size={18} color={theme.colors.ink2} strokeWidth={1.75} />
              <Text size={14.5} weight={500} numberOfLines={1} style={{ flex: 1 }}>
                {files[field.id] ?? words.chooseFile}
              </Text>
              {files[field.id] ? (
                <Check size={16} color={theme.faces.banjo.accent} strokeWidth={2.25} />
              ) : null}
            </Touchable>
          ) : (
            <TextInput
              value={values[field.id] ?? ''}
              onChangeText={(v) => set(field.id, v)}
              placeholder={field.placeholder ?? undefined}
              placeholderTextColor={theme.colors.placeholder}
              accessibilityLabel={field.label}
              secureTextEntry={field.kind === 'secret'}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              importantForAutofill="no"
              spellCheck={false}
              editable={!busy}
              selectionColor={theme.colors.brand}
              cursorColor={theme.colors.ink}
              style={{
                minHeight: 44,
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: errors[field.id] ? theme.colors.bad : theme.colors.line2,
                backgroundColor: theme.colors.bg,
                color: theme.colors.ink,
                fontFamily: input.fontFamily,
                fontSize: input.fontSize,
                includeFontPadding: false,
              }}
            />
          )}
          <FieldError text={errors[field.id]} />
        </View>
      ))}
      <Button label={block.submitLabel} busy={busy} onPress={() => void submit()} />
    </View>
  );
}

/* Connect --------------------------------------------------------------------------------------------- */

/**
 * “Connect Google” in a guide (AG-05, AG-08) on the phone (phone-connect.md PC-02, PC-05, AP-2907): on a managed
 * Whombat the sign-in starts here over the session with the card's services and its `returnTo` (the DM, where the
 * server posts the result), the provider's page opens in the browser and comes back through the `/connect/` App Link;
 * Email (IMAP) opens its screen. A self-hosted Whombat's sign-in still happens on its web page (the DM there).
 */
function ConnectBlock({ block, web }: { block: GuideConnectBlock; web: GuideWeb }) {
  const { rawLocale } = useI18n();

  const theme = useTheme();
  const managed = useManaged();
  const startGoogle = useStartGoogleConnection((url) => void Linking.openURL(url).catch(() => {}));
  const startMicrosoft = useStartMicrosoftConnection();
  const [problem, setProblem] = useState<string | null>(null);
  const url = connectWebUrl(web, block);
  const here = !!managed || block.provider === 'imap';

  async function start() {
    setProblem(null);
    if (block.provider === 'imap') {
      openAppUrl('whombat://settings/connections/account/imap');
      return;
    }
    if (!managed) return;
    holdPhoneConnect({ device: managed.applianceId });
    try {
      const body = { services: [...block.services], returnTo: block.returnTo };
      if (block.provider === 'google') await startGoogle.mutateAsync({ body });
      else {
        const result = await startMicrosoft.mutateAsync({ body });
        if (result.status === 'ok') void Linking.openURL(result.data.authorizeUrl).catch(() => {});
      }
    } catch (err) {
      setProblem(problemText(err, connectStartProblem(block, rawLocale), rawLocale));
    }
  }

  return (
    <View style={{ gap: 10 }}>
      <Text size={13.5} lh={1.45} color={theme.colors.ink2}>
        {connectNote(block, rawLocale)}
      </Text>
      {here ? (
        <Button
          label={connectAppLabel(block, rawLocale)}
          busy={startGoogle.isPending || startMicrosoft.isPending}
          onPress={() => void start()}
        />
      ) : url ? (
        <Button label={connectLabel(block, rawLocale)} accessibilityHint={url} onPress={() => openUrl(url)} />
      ) : null}
      {problem ? (
        <Text size={13} lh={1.4} color={theme.colors.bad} accessibilityLiveRegion="polite">
          {problem}
        </Text>
      ) : null}
    </View>
  );
}
