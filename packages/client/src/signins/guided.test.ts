import { describe, expect, it } from 'vitest';
import {
  claudeSignInUrl,
  codexSignInUrl,
  createSignInOutputWatcher,
  isCodeShaped,
  linkHost,
  readSignInOutput,
  stripAnsi,
} from './guided';

const URL_2_1_283 =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=XmPLYIbUnBx871cDBnBM53zXwXXYyuzOouPFa9zZeE0&code_challenge_method=S256&state=yH-DB74PERpEKA2Q9bdO8XY7A3m1KhYLNUhCOwFrImM';

/** Claude Code 2.1.283's `claude auth login --claudeai`, byte for byte (recorded in a PTY). */
const REAL = [
  'Opening browser to sign in…\r\n',
  `If the browser didn't open, visit: \u001b]8;;${URL_2_1_283}\u0007\u001b[94m${URL_2_1_283}\u001b[39m\u001b]8;;\u0007\r\n`,
  'Paste code here if prompted > ',
].join('');

describe('readSignInOutput', () => {
  it('takes the link from the OSC 8 hyperlink target', () => {
    expect(readSignInOutput(REAL)).toEqual({
      url: URL_2_1_283,
      foreignUrl: false,
      loginFailed: false,
      prompts: 1,
    });
  });

  it('prefers the hyperlink target over the text it shows', () => {
    const out = `visit: \u001b]8;;https://claude.ai/oauth/a\u001b\\https://claude.ai/shown\u001b]8;;\u001b\\\r\n`;
    expect(readSignInOutput(out).url).toBe('https://claude.ai/oauth/a');
  });

  it('reads a plain link after “visit:”', () => {
    const out = `If the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true&state=abc\r\nPaste code here if prompted > `;
    expect(readSignInOutput(out).url).toBe('https://claude.ai/oauth/authorize?code=true&state=abc');
  });

  it('reads a coloured link and one wrapped over several lines', () => {
    const coloured = `visit: \u001b[4m\u001b[38;2;215;119;87mhttps://claude.ai/oauth/authorize?x=1\u001b[0m\r\n`;
    expect(readSignInOutput(coloured).url).toBe('https://claude.ai/oauth/authorize?x=1');
    const wrapped = `visit:\r\n\u001b[94mhttps://claude.com/cai/oauth/authorize?code=tr\r\nue&state=abc%2Fdef\r\nxyz\u001b[39m\r\n\r\nPaste code here if prompted > `;
    expect(readSignInOutput(wrapped).url).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&state=abc%2Fdefxyz',
    );
  });

  it('waits for the end of the link’s line', () => {
    expect(readSignInOutput('visit: https://claude.ai/oauth/auth').url).toBeNull();
    expect(readSignInOutput('visit: \u001b]8;;https://claude.ai/oau').url).toBeNull();
    expect(readSignInOutput('Opening browser to sign in…\r\n').url).toBeNull();
  });

  it('offers no link to other hosts, or without https', () => {
    for (const raw of [
      'https://evil.example/oauth',
      'https://claude.ai.evil.example/x',
      'https://notclaude.ai/x',
      'http://claude.ai/oauth',
      'javascript:alert(1)',
      'https://user:pw@claude.ai/x',
    ]) {
      const out = readSignInOutput(`visit: \u001b]8;;${raw}\u0007${raw}\u001b]8;;\u0007\r\n`);
      expect(out.url, raw).toBeNull();
      expect(out.foreignUrl, raw).toBe(true);
    }
    for (const ok of [
      'https://claude.ai/x',
      'https://claude.com/x',
      'https://platform.claude.com/x',
      'https://console.anthropic.com/x',
    ])
      expect(claudeSignInUrl(ok)).toBe(ok);
  });

  it('notices “Login failed” and new prompts', () => {
    const failed = `${REAL}\r\n\u001b[31mLogin failed: Request failed with status code 400\u001b[39m\r\n`;
    expect(readSignInOutput(failed).loginFailed).toBe(true);
    expect(readSignInOutput(`${REAL}\r\nPaste code here if prompted > `).prompts).toBe(2);
  });
});

describe('createSignInOutputWatcher', () => {
  it('reads the link from output split anywhere, even inside a UTF-8 character', () => {
    const bytes = new TextEncoder().encode(REAL);
    const bel = bytes.indexOf(7);
    for (const cut of [1, 25, 27, 60, 200, bel - 5, bel]) {
      const w = createSignInOutputWatcher();
      expect(w.push(bytes.subarray(0, cut)).url).toBeNull();
      expect(w.push(bytes.subarray(cut)).url).toBe(URL_2_1_283);
    }
  });

  it('keeps reading the tail of a long output', () => {
    const w = createSignInOutputWatcher();
    const enc = new TextEncoder();
    w.push(enc.encode(REAL));
    w.push(enc.encode('x'.repeat(80_000)));
    const out = w.push(enc.encode('\r\nLogin failed: Request failed with status code 400\r\n'));
    expect(out).toMatchObject({ url: URL_2_1_283, loginFailed: true });
  });
});

describe('codexSignInUrl', () => {
  it('accepts openai.com and chatgpt.com over https only', () => {
    expect(codexSignInUrl('https://auth.openai.com/codex/device')).toBe(
      'https://auth.openai.com/codex/device',
    );
    expect(codexSignInUrl('https://chatgpt.com/device')).toBe('https://chatgpt.com/device');
    expect(codexSignInUrl('http://auth.openai.com/codex/device')).toBeNull();
    expect(codexSignInUrl('https://openai.com.evil.example/')).toBeNull();
    expect(codexSignInUrl('https://notopenai.com/')).toBeNull();
    expect(codexSignInUrl('nonsense')).toBeNull();
  });
});

describe('isCodeShaped', () => {
  it('takes 20–512 characters without whitespace inside', () => {
    expect(isCodeShaped('  AbCdEfGhIjKlMnOpQrStUv-_#XyZaBcDeFgHiJ012 \n')).toBe(true);
    expect(isCodeShaped('short#code')).toBe(false);
    expect(isCodeShaped('this has spaces inside it, so not a code')).toBe(false);
    expect(isCodeShaped('a'.repeat(513))).toBe(false);
    expect(isCodeShaped('a'.repeat(20))).toBe(true);
  });
});

describe('helpers', () => {
  it('strips escapes and names a link’s host', () => {
    expect(stripAnsi('\u001b[1mbold\u001b[0m \u001b]8;;u\u0007t\u001b]8;;\u0007')).toBe('bold t');
    expect(linkHost('https://auth.openai.com/codex/device')).toBe('auth.openai.com');
  });
});
