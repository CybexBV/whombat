import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import type { Logger } from '../services';
import { productionTestEnv } from '../test/env';
import { createMailer, type MailMessage } from './mailer';

const SIGN_IN: MailMessage = {
  to: 'victim@corp.test',
  subject: 'Your Whombat sign-in code: 482913',
  text: 'Sign in to Whombat:\n\nhttps://whombat.com/login/verify?token=ml_secret\n\nOr type this code: 482913\n',
};

function capture() {
  const lines: { obj: unknown; msg?: string }[] = [];
  const log = (obj: unknown, msg?: string) => lines.push({ obj, msg });
  const logger: Logger = { info: log, warn: log, error: log, debug: log };
  return { lines, logger, text: () => JSON.stringify(lines) };
}

describe('createMailer', () => {
  it('never writes the sign-in code, link or subject to the log outside development', async () => {
    for (const NODE_ENV of ['production', 'test'] as const) {
      const log = capture();
      const sent: unknown[] = [];
      const mailer = createMailer(
        loadConfig(NODE_ENV === 'production' ? productionTestEnv() : { NODE_ENV }),
        () => log.logger,
        {
          sendMail: async (m) => {
            sent.push(m);
          },
        },
      );
      await mailer.send(SIGN_IN);
      expect(log.lines).toHaveLength(1);
      expect(log.lines[0]).toEqual({ obj: { to: 'victim@corp.test' }, msg: 'email' });
      expect(log.text()).not.toContain('482913');
      expect(log.text()).not.toContain('ml_secret');
      if (NODE_ENV === 'production') expect(sent).toHaveLength(1);
    }
  });
});
