/**
 * What {assistant} may do → KEYS → **Always allowed commands**, folded there (Whombat agent-computer.md AC-42; contracts
 * CT-221; AP-622; the command guard stays without a computer, one-person.md AP-5691): the commands the person allowed
 * the assistant for good (“Always allow” on a command card), newest first, each the exact command in mono with its
 * target and key under it and **Remove** (the command asks again next time). Removing is at once, not part of the keys'
 * draft: it takes something away, like taking a Vault key back.
 */
import { ApiError } from '@whombat/client';
import { useCommandAllowances, useRemoveCommandAllowance } from '@whombat/client/react';
import { COMMAND_ALLOWANCES_COPY, commandAllowanceLine } from '@whombat/core/commands';
import { useState } from 'react';
import { Button } from '../../../components/Button';
import { SkeletonRows } from '../../../components/ListState';
import { useToast } from '../../../components/Toast';
import settings from './AgentTab.module.css';
import styles from './Services.module.css';

const FAILED = 'That didn’t work. Try again in a moment.';

export function CommandAllowances({ burrow, className }: { burrow: string; className?: string }) {
  const toast = useToast();
  const { data } = useCommandAllowances({ params: { burrow } });
  const remove = useRemoveCommandAllowance(burrow);
  const [problem, setProblem] = useState<string | null>(null);
  const allowances = data?.allowances;
  return (
    <div className={className}>
      {!allowances ? (
        <SkeletonRows count={1} lines={1} />
      ) : allowances.length === 0 ? (
        <p className={settings.hint}>{COMMAND_ALLOWANCES_COPY.empty}</p>
      ) : (
        <ul className={styles.rows} aria-label={COMMAND_ALLOWANCES_COPY.title}>
          {allowances.map((a) => (
            <li key={a.id} className={styles.row}>
              <span className={styles.rowMain}>
                <code className={styles.command}>{a.command}</code>
                <span className={styles.rowLine}>{commandAllowanceLine(a)}</span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={remove.isPending}
                aria-label={`${COMMAND_ALLOWANCES_COPY.remove}: ${a.command}`}
                onClick={async () => {
                  setProblem(null);
                  try {
                    const result = await remove.mutateAsync({ allowanceId: a.id });
                    if (result.status === 'ok') toast.show(COMMAND_ALLOWANCES_COPY.removed);
                    else setProblem(result.status === 'blocked' ? result.message : FAILED);
                  } catch (e) {
                    setProblem(e instanceof ApiError && e.message ? e.message : FAILED);
                  }
                }}
              >
                {COMMAND_ALLOWANCES_COPY.remove}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {problem && (
        <p className={settings.error} role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
