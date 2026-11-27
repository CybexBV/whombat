import { Link } from '@tanstack/react-router';
import { gatewayCarries, localModelOf } from '@whombat/client';
import { useBootstrap, useTheAgent } from '@whombat/client/react';
import { CLIENT_NAMES, clientReady, REFUSAL_TEXT, SOURCE_TEXT, signInOf } from '@whombat/client/signins';
import { agentsCanReply, engineReady, LIVE_PROVIDERS } from '@whombat/core/domain';
import { agentsBlockedNotice } from '@whombat/core/text';
import { useEffect, useState } from 'react';
import { StatusDot } from '../../components/StatusDot';
import { useAgentSetupStatus } from '../../features/agent/AiProviderPanel';
import { useClientsStatus, useSignInsStatus } from '../../features/ai/useAi';
import { useWebI18n } from '../../i18n/provider';
import { useAppServices } from '../providers';
import styles from './ShellLayout.module.css';

/**
 * A quiet line above the screen while the agent can't reply on this Whombat (no runner, what turns run on not ready —
 * the contracts' words, never its name, hermes-engine-app.md AP-5040 — or neither Claude Code, ChatGPT nor a model on the
 * network ready — docs/decisions/agent-setup.md; not in the mocks). Hidden on Settings, which shows why: its link
 * opens Settings → AI at AI CLIENTS, where the provider readiness lives (docs/decisions/settings-simplify.md SS-03).
 *
 * On a managed Whombat the agent works on the account of whoever asks (SUB-04): while the person hasn't signed in to any
 * provider this Whombat has — Claude Code once it is installed, ChatGPT always (it needs nothing installed,
 * chatgpt-no-client.md AP-5616) — the line says so (the refusal they'd get, `provider.requester_not_signed_in`: “… to
 * Claude Code or ChatGPT …”) with a way to Settings → AI. Neither line shows while the burrow's AI gateway carries a tool the runner has (Whombat ai-gateway.md
 * AIG-07, AIG-16; AP-1126): its turns need nobody's sign-in.
 */
export function AgentsBlockedNotice({ burrow, onSettings }: { burrow: string; onSettings: boolean }) {
  const { tag: uiLocale } = useWebI18n();
  const { managed } = useAppServices();
  // Read at mount and on `agent.updated`; polled only while a notice shows (web-efficiency.md WE-06).
  const { data: status } = useAgentSetupStatus(burrow);
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const { agent, words } = useTheAgent(burrow);
  const localModel = localModelOf(bootstrap?.burrow);
  const [signInShown, setSignInShown] = useState(false);
  const signIns = useSignInsStatus(!!managed && !onSettings, { poll: signInShown });
  const clients = useClientsStatus(!!managed && !onSettings, { poll: signInShown });
  // The gateway carries a tool the runner has: the agent replies without anyone's sign-in (AP-1126).
  const viaGateway = !!status && engineReady(status) && gatewayCarries(bootstrap?.burrow, status.providers);
  const blocked = !!status && !agentsCanReply(status, localModel) && !viaGateway;
  // An agent on the model on the network needs nobody's sign-in (AP-5041).
  const onLocal = agent?.runtime.provider === 'local' && !!localModel;
  const available = managed && clients.data ? LIVE_PROVIDERS.filter((p) => clientReady(p, clients.data)) : [];
  const notSignedIn =
    !onSettings &&
    !blocked &&
    !viaGateway &&
    !onLocal &&
    !!signIns.data &&
    available.length > 0 &&
    !available.some((p) => signInOf(signIns.data, p)?.state === 'ready');
  useEffect(() => setSignInShown(notSignedIn), [notSignedIn]);
  if (onSettings) return null;
  if (blocked)
    return (
      <div className={styles.notice} role="status">
        <StatusDot tone="warn" size={7} label={null} />
        <span className={styles.noticeText}>{agentsBlockedNotice(status, words.name, uiLocale)}</span>
        <Link
          to="/settings"
          search={{ tab: 'advanced', part: 'ai' }}
          hash="clients"
          className={styles.noticeLink}
        >
          Set up AI provider
        </Link>
      </div>
    );
  if (!notSignedIn) return null;
  // Every AI the person can choose, installed or not (Settings → AI installs Claude Code): naming only the ones ready
  // here made it look as if the Whombat had chosen ChatGPT for them (first-day.md FDY-33).
  const names = LIVE_PROVIDERS.map((p) => CLIENT_NAMES[p]).join(' or ');
  return (
    <div className={styles.notice} role="status">
      <StatusDot tone="warn" size={7} label={null} />
      <span className={styles.noticeText}>
        {REFUSAL_TEXT['provider.requester_not_signed_in']?.text(names)}
      </span>
      <Link to="/settings" search={{ tab: 'agent', part: 'ai' }} className={styles.noticeLink}>
        {SOURCE_TEXT.signIn}
      </Link>
    </div>
  );
}
