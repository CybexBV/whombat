/**
 * An entry's one row for the agent (Whombat vault-self-serve.md VS-03, one-agent.md OA-09, hermes-engine.md HE-43;
 * contracts 0.125 CT-1240; app AP-5240, AP-5241, was AP-4000…AP-4004, AP-4940): the agent's face, “Neo can use this”
 * and On · Off with the chosen one's hint (core's `vaultAgentAccessCopy`). On switches it on for the agent on All
 * servers (`vault.giveKey`), Off switches it off (`vault.takeKey`). It reaches the agent in your chats, in its
 * commands: beneath the row, while on, how — a server key for signing in to its servers, a login in its
 * browser, an MCP server's tools — and, under Advanced, the environment variable an API's value is in (named there,
 * `vault.setKeyEnvName`). Switching off something that was in its commands says to change the secret.
 */

import { WhombatAvatar } from '@whombat/avatars/react';
import { agentFaceOf, vaultProblemOf } from '@whombat/client';
import { useTheAgent, useVaultWrite } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import {
  VAULT_AGENT_ACCESS,
  VAULT_KEYS_COPY,
  type VaultAgentAccess,
  type VaultEntryDetail,
  vaultAgentAccessCopy,
  vaultKeyServersText,
  vaultRotateNotice,
} from '@whombat/core/vault';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useToast } from '../../components/Toast';
import { useWebI18n } from '../../i18n/provider';
import { VAULT_TEXT } from './copy';
import { Fold } from './Fold';
import { envNameBody, envNameOf, hasEnvName, inCommands } from './model';
import { GenerateDialog } from './SshKey';
import styles from './Vault.module.css';

/**
 * How an entry that is on reaches the agent: the line under the row, in core's words; a server key's in
 * plain ones, with the agent by name (its SSH configuration is a technical detail).
 */
function howLine(entry: Pick<VaultEntryDetail, 'kind'>, agentName: string): string | null {
  switch (entry.kind) {
    case 'ssh':
      return `${agentName} uses it to sign in to these servers in your chats.`;
    case 'login':
      return VAULT_KEYS_COPY.loginHint;
    case 'mcp':
      return VAULT_KEYS_COPY.mcpHint;
    default:
      return null;
  }
}

export function AgentAccess({ burrow, entry }: { burrow: string; entry: VaultEntryDetail }) {
  const { tag: uiLocale } = useWebI18n();
  const toast = useToast();
  const { agent } = useTheAgent(burrow);
  const give = useVaultWrite(api.vault.giveKey, burrow);
  const take = useVaultWrite(api.vault.takeKey, burrow);
  const setEnvName = useVaultWrite(api.vault.setKeyEnvName, burrow);
  const [choosing, setChoosing] = useState<VaultAgentAccess | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [envProblem, setEnvProblem] = useState<string | null>(null);
  const [rotate, setRotate] = useState<{ text: string; action: string | null } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = { hint: useId(), env: useId(), envHint: useId(), envError: useId() };
  const key = entry.key;
  // Nothing to switch until the agent is known.
  if (!agent) return null;

  const name = agent.name;
  const copy = vaultAgentAccessCopy(name, uiLocale);
  const value: VaultAgentAccess = key ? 'on' : 'off';
  const shown = choosing ?? value;
  const busy = give.isPending || take.isPending || setEnvName.isPending;
  const params = { burrow, entryId: entry.id };
  const how = key ? howLine(entry, name) : null;
  const envName = key && hasEnvName(entry) ? envNameOf(entry, key) : null;

  async function choose(next: VaultAgentAccess) {
    if (next === value) return;
    setProblem(null);
    setRotate(null);
    setNaming(null);
    setChoosing(next);
    try {
      if (next === 'off') {
        const result = await take.mutateAsync({ params });
        // It was in its commands: it may have kept a copy (AC-34).
        if (result.status === 'ok' && inCommands(entry))
          setRotate(vaultRotateNotice({ agentName: name, entryName: entry.name, kind: entry.kind }));
      } else {
        // All servers: the row has no chooser, so a change covers every server of an SSH key (VS-03).
        await give.mutateAsync({ params, body: { servers: null } });
      }
    } catch (error) {
      setProblem(vaultProblemOf(error).message ?? VAULT_TEXT.failed);
    } finally {
      setChoosing(null);
    }
  }

  async function saveEnvName(typed: string) {
    const result = envNameBody(typed);
    if ('problem' in result) return setEnvProblem(result.problem);
    setEnvProblem(null);
    try {
      const r = await setEnvName.mutateAsync({ params, body: result.body });
      if (r.status === 'ok') {
        setNaming(null);
        toast.show(VAULT_TEXT.saved);
      }
    } catch (error) {
      const p = vaultProblemOf(error);
      if (p.fields.envName) setEnvProblem(p.fields.envName);
      else setProblem(p.message ?? VAULT_TEXT.failed);
    }
  }

  return (
    <div className={styles.block} data-block="agent-access">
      <div className={styles.access}>
        <span className={styles.agent}>
          <WhombatAvatar face={agentFaceOf(agent)} crop="head" size={26} />
          <span className={styles.rowMain} aria-hidden="true">
            <span className={styles.agentName}>{copy.title}</span>
            <span id={ids.hint} className={styles.rowMeta}>
              {copy.hints[shown]}
            </span>
          </span>
        </span>
        <SegmentedControl<VaultAgentAccess>
          size="sm"
          role="radiogroup"
          label={copy.title}
          describedBy={ids.hint}
          value={shown}
          disabled={busy}
          onChange={(next) => void choose(next)}
          options={VAULT_AGENT_ACCESS.map((c) => ({ value: c, label: copy.choices[c] }))}
        />
      </div>
      {key && (how || envName || (entry.kind === 'ssh' && key.servers !== null)) ? (
        <div className={styles.accessMore}>
          {/* A key from before that covers some servers only: said, until a change makes it All servers (AP-4002). */}
          {entry.kind === 'ssh' && key.servers !== null && (
            <span className={styles.servers}>
              {VAULT_TEXT.assistantServers(vaultKeyServersText(key.servers, entry.servers))}
            </span>
          )}
          {how && <p className={styles.hint}>{how}</p>}
          {envName && (
            <Fold label={VAULT_TEXT.advanced} name="advanced">
              {naming === null ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.accessHow}
                  disabled={busy}
                  aria-label={`${VAULT_KEYS_COPY.envName}: ${envName}`}
                  onClick={() => {
                    setEnvProblem(null);
                    setNaming(envName);
                  }}
                >
                  <span>
                    {VAULT_TEXT.envNameRow} · <span className={styles.servers}>{envName}</span>
                  </span>
                </Button>
              ) : (
                <div className={`${styles.field} ${styles.envField}`} data-chooser="env-name">
                  <label className={styles.fieldLabel} htmlFor={ids.env}>
                    {VAULT_KEYS_COPY.envName}
                  </label>
                  <Input
                    id={ids.env}
                    className={styles.monoInput}
                    spellCheck={false}
                    autoCapitalize="characters"
                    autoComplete="off"
                    maxLength={64}
                    value={naming}
                    invalid={!!envProblem}
                    aria-describedby={[envProblem ? ids.envError : null, ids.envHint]
                      .filter(Boolean)
                      .join(' ')}
                    onChange={(e) => {
                      setEnvProblem(null);
                      setNaming(e.target.value);
                    }}
                  />
                  {envProblem && (
                    <p id={ids.envError} className={styles.fieldError}>
                      {envProblem}
                    </p>
                  )}
                  <p id={ids.envHint} className={styles.hint}>
                    {VAULT_KEYS_COPY.envNameHint}
                  </p>
                  <div className={styles.actions}>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={setEnvName.isPending}
                      onClick={() => void saveEnvName(naming)}
                    >
                      {VAULT_TEXT.save}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setNaming(null)}>
                      {VAULT_TEXT.cancel}
                    </Button>
                  </div>
                </div>
              )}
            </Fold>
          )}
        </div>
      ) : null}
      {rotate && (
        <div className={styles.warnNote} role="status" data-notice="rotate">
          <p className={styles.noticeText}>{rotate.text}</p>
          {rotate.action && entry.kind === 'ssh' && (
            <div className={styles.actions}>
              <Button variant="secondary" size="sm" onClick={() => setGenerating(true)}>
                {rotate.action}
              </Button>
            </div>
          )}
        </div>
      )}
      {entry.kind === 'ssh' && (
        <GenerateDialog
          burrow={burrow}
          entry={entry}
          open={generating}
          onOpenChange={setGenerating}
          onGenerated={() => setRotate(null)}
        />
      )}
      {problem && (
        <p className={styles.error} role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
