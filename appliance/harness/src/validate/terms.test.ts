import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APPLIANCE_TERMS, compareTerms, fileAtPin } from './terms.ts';

describe('appliance terms gate (LC-17)', () => {
  it('passes only byte-identical copies', () => {
    const t = Buffer.from('> “Version” `2026-11-15`.\n\n# Whombat Appliance Terms\n');
    expect(compareTerms(t, Buffer.from(t)).ok).toBe(true);
    const curly = Buffer.from(t.toString().replace('“', '"'));
    const r = compareTerms(curly, t);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('line 1');
    expect(compareTerms(Buffer.concat([t, Buffer.from('\n')]), t).ok).toBe(false);
    expect(compareTerms(null, t).summary).toContain('app commit');
  });

  it('reads the appliance’s copy from its folder in the one repository, and from the top before it moved', () => {
    const repo = mkdtempSync(join(tmpdir(), 'terms-'));
    const git = (...a: string[]) =>
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], {
        encoding: 'utf8',
      }).trim();
    git('init', '-q');
    const put = (path: string, text: string) => {
      mkdirSync(join(repo, path, '..'), { recursive: true });
      writeFileSync(join(repo, path), text);
      git('add', '-A');
      git('commit', '-q', '-m', path);
      return git('rev-parse', 'HEAD');
    };
    const top = put(APPLIANCE_TERMS, 'at the top\n');
    git('rm', '-q', APPLIANCE_TERMS);
    const folder = put(`appliance/${APPLIANCE_TERMS}`, 'in the folder\n');
    expect(fileAtPin(repo, folder, 'appliance', APPLIANCE_TERMS)?.toString()).toBe('in the folder\n');
    // A pin with the folder at a commit from before the move, and a pin without one.
    expect(fileAtPin(repo, top, 'appliance', APPLIANCE_TERMS)?.toString()).toBe('at the top\n');
    expect(fileAtPin(repo, top, undefined, APPLIANCE_TERMS)?.toString()).toBe('at the top\n');
    expect(fileAtPin(repo, folder, undefined, APPLIANCE_TERMS)).toBeNull();
  });
});
