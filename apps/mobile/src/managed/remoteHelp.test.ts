/**
 * Remote help's phone pieces (app remote-help.md AP-4473…AP-4477): the dialog's answers, how much of a command line the
 * sheet shows, the file's name and what Share and Download leave behind, and what TalkBack reads.
 */
import { REMOTE_HELP_WORDS } from '@whombat/client/managed';
import { describe, expect, it } from 'vitest';
import {
  type AlertButton,
  downloadTranscript,
  helpCodeSpoken,
  remoteHelpConfirm,
  remoteHelpStepLabel,
  type ShowAlert,
  shareTranscript,
  type TranscriptFiles,
  transcriptFileName,
  transcriptShown,
} from './remoteHelp';

const W = REMOTE_HELP_WORDS;

/** An alert that records what it showed and lets the test press a button or dismiss it. */
function alerts() {
  const shown: { title: string; message: string; buttons: AlertButton[]; dismiss: () => void }[] = [];
  const show: ShowAlert = (title, message, buttons, options) =>
    shown.push({ title, message, buttons, dismiss: options.onDismiss });
  const press = (text: string) =>
    shown
      .at(-1)
      ?.buttons.find((b) => b.text === text)
      ?.onPress?.();
  return { show, shown, press };
}

describe('the no-passkey dialog', () => {
  it('asks with the shared title, the choice in words, Cancel and Turn on', async () => {
    const a = alerts();
    const answer = remoteHelpConfirm(a.show)({ level: 'fix', duration: 'week' });
    const [dialog] = a.shown;
    expect(dialog?.title).toBe(W.confirm.title);
    expect(dialog?.message).toContain('look and fix');
    expect(dialog?.buttons.map((b) => b.text)).toEqual([W.confirm.cancel, W.confirm.turnOn]);
    expect(dialog?.buttons[0]?.style).toBe('cancel');
    a.press(W.confirm.turnOn);
    await expect(answer).resolves.toBe(true);
  });

  it('answers false for Cancel and for a dialog closed beside it, once', async () => {
    const a = alerts();
    const cancelled = remoteHelpConfirm(a.show)({ level: 'look', duration: 'hour' });
    a.press(W.confirm.cancel);
    a.press(W.confirm.turnOn);
    await expect(cancelled).resolves.toBe(false);

    const dismissed = remoteHelpConfirm(a.show)({ level: 'look', duration: 'forever' });
    a.shown.at(-1)?.dismiss();
    await expect(dismissed).resolves.toBe(false);
  });
});

describe('the command line in the sheet', () => {
  it('shows a short record whole', () => {
    expect(transcriptShown('root@whombat:~# exit\n\n')).toEqual({ text: 'root@whombat:~# exit', cut: false });
  });

  it('shows the start of a long one, cut at a line', () => {
    const text = `${'a'.repeat(60)}\n${'b'.repeat(60)}\n${'c'.repeat(60)}`;
    const shown = transcriptShown(text, 130);
    expect(shown.cut).toBe(true);
    expect(shown.text).toBe(`${'a'.repeat(60)}\n${'b'.repeat(60)}`);
  });

  it('never ends in half a character when there is no line to cut at', () => {
    const text = `${'x'.repeat(9)}😀${'y'.repeat(20)}`;
    const shown = transcriptShown(text, 10);
    expect(shown).toEqual({ text: 'x'.repeat(9), cut: true });
  });
});

/** The phone's files in memory: what is in the cache and in the documents, and what the share sheet got. */
function files(options: { target?: string | null; shareFails?: boolean; writeFails?: boolean } = {}) {
  const cache = new Map<string, Uint8Array>();
  const documents = new Map<string, Uint8Array>();
  const shared: { uri: string; name: string; bytes: Uint8Array | undefined }[] = [];
  const picked: string[] = [];
  const api: TranscriptFiles = {
    writeCache(name, bytes) {
      cache.set(name, bytes);
      return `file:///cache/${name}`;
    },
    removeCache: (name) => void cache.delete(name),
    async share(uri, name) {
      shared.push({ uri, name, bytes: cache.get(name) });
      if (options.shareFails) throw new Error('no share sheet');
    },
    async pickTarget(name) {
      picked.push(name);
      return options.target === undefined ? `content://downloads/${name}` : options.target;
    },
    writeDocument(uri, bytes) {
      documents.set(uri, new Uint8Array());
      if (options.writeFails) throw new Error('provider went away');
      documents.set(uri, bytes);
    },
    removeDocument: (uri) => void documents.delete(uri),
  };
  return { api, cache, documents, shared, picked };
}

const BYTES = new TextEncoder().encode('root@whombat:~# exit\n');

describe('Share and Download', () => {
  it('names the file after the visit, never after what the box sent', () => {
    expect(transcriptFileName('vis_01')).toBe('whombat-remote-help-vis_01.txt');
    expect(() => transcriptFileName('../../databases/x')).toThrow();
  });

  it('shares a copy from the cache and takes it away again, also when sharing fails', async () => {
    const ok = files();
    await shareTranscript(ok.api, 'vis_01', BYTES);
    expect(ok.shared).toEqual([
      {
        uri: 'file:///cache/whombat-remote-help-vis_01.txt',
        name: 'whombat-remote-help-vis_01.txt',
        bytes: BYTES,
      },
    ]);
    expect(ok.cache.size).toBe(0);

    const failing = files({ shareFails: true });
    await expect(shareTranscript(failing.api, 'vis_01', BYTES)).rejects.toThrow();
    expect(failing.cache.size).toBe(0);
  });

  it('saves the bytes where the owner chose, nothing when they backed out', async () => {
    const ok = files();
    expect(await downloadTranscript(ok.api, 'vis_01', BYTES)).toBe(true);
    expect(ok.picked).toEqual(['whombat-remote-help-vis_01.txt']);
    expect(ok.documents.get('content://downloads/whombat-remote-help-vis_01.txt')).toEqual(BYTES);

    const back = files({ target: null });
    expect(await downloadTranscript(back.api, 'vis_01', BYTES)).toBe(false);
    expect(back.documents.size).toBe(0);
  });

  it('takes a half-written file away again', async () => {
    const failing = files({ writeFails: true });
    await expect(downloadTranscript(failing.api, 'vis_01', BYTES)).rejects.toThrow();
    expect(failing.documents.size).toBe(0);
  });
});

describe('TalkBack', () => {
  it('reads a step as its time and its words, with the command line', () => {
    expect(remoteHelpStepLabel({ time: '14:02', text: 'Ran', code: 'systemctl status whombat-voice' })).toBe(
      '14:02, Ran systemctl status whombat-voice',
    );
    expect(remoteHelpStepLabel({ time: '', text: 'Earlier steps aren’t shown.', code: null })).toBe(
      'Earlier steps aren’t shown.',
    );
  });

  it('spells the help code one character at a time', () => {
    expect(helpCodeSpoken('KQ7·2MX')).toBe('K Q 7 2 M X');
  });
});
