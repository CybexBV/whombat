/**
 * The runner's one-time move of the files it kept per account (one-person.md OP-S131…OP-S134), on a temporary tree laid
 * out as a box several people used left it.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { accountFolders, moveToOnePerson, type OnePersonFilesOptions } from './one-person-files';

const SEP = '\n§\n';
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), 'wb-one-person-'));
  dirs.push(d);
  return d;
}

async function put(path: string, text = 'x') {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const ls = async (path: string) => (await readdir(path).catch(() => [] as string[])).sort();
const text = (path: string) => readFile(path, 'utf8');

async function tree() {
  const dir = await tempDir();
  const hermes = join(dir, 'hermes');
  const creds = join(dir, 'credentials');
  const workspaces = join(dir, 'workspaces');
  const p = (name: string, rel: string) => join(hermes, 'profiles', name, rel);
  // Mara's Hermes home, with a changed copy of a shared skill and a skill of her own.
  await put(p('acc_mara', 'config.yaml'), 'skills: {external_dirs: [x]}');
  await put(p('acc_mara', 'state.db'), 'mara-sessions');
  await put(p('acc_mara', 'auth.json'), '{}');
  await put(p('acc_mara', '.no-bundled-skills'));
  await put(p('acc_mara', 'memories/MEMORY.md'), ['Mara drinks tea', 'The NAS is shale'].join(SEP));
  await put(p('acc_mara', 'skills/learned-a/SKILL.md'), 'mara-a');
  await put(p('acc_mara', 'skills/devops/deploy/SKILL.md'), 'mara-deploy');
  await put(p('acc_mara', 'skills/.bundled_manifest'), 'hermes-agent:1');
  // Someone else's, the shared one of turns for nobody, the outsiders'.
  await put(p('acc_joris', 'state.db'), 'joris-sessions');
  await put(p('_shared', 'memories/MEMORY.md'), ['The NAS is shale', 'Backups run at 3'].join(SEP));
  await put(p('_shared', 'skills/learned-a/SKILL.md'), 'shared-a');
  await put(p('_shared', 'skills/learned-b/SKILL.md'), 'shared-b');
  await put(p('_feedback', 'state.db'), 'reports');
  // The old shared skills folder at the root: a built-in Mara changed, Whombat's bookkeeping.
  await put(join(hermes, 'skills/devops/deploy/SKILL.md'), 'built-in');
  await put(join(hermes, 'skills/.whombat/skills.json'), '{"v":2}');
  await put(join(hermes, 'pending/acc_mara.json'), JSON.stringify([{ id: 's-1', attempts: 1 }]));
  await put(join(hermes, 'pending/_feedback.json'), JSON.stringify([{ id: 's-r', attempts: 0 }]));
  await put(join(hermes, 'pending/_shared.json'), JSON.stringify([{ id: 's-n', attempts: 0 }]));
  await put(join(hermes, 'pending/acc_joris.json'), JSON.stringify([{ id: 's-j', attempts: 0 }]));
  await put(join(creds, 'acc_mara/claude/config/.credentials.json'), 'mara-claude');
  await put(join(creds, 'acc_mara/github/whombat-credential.json'), 'mara-gh');
  await put(join(creds, 'acc_joris/codex/whombat-credential.json'), 'joris');
  await put(join(creds, 'org/cred_1/claude/api-key'), 'org-key');
  await put(join(creds, 'gateway/con_1/claude/config/settings.json'), '{}');
  await put(join(workspaces, '.computers/agt_dusty/work/site/index.html'), 'hello');
  await put(join(workspaces, '.computers/agt_dusty/home/.bashrc'), '');
  return { hermes, creds, workspaces, agentHome: join(dir, 'agent/home') };
}

function options(
  t: Awaited<ReturnType<typeof tree>>,
  person: () => Promise<string | null>,
): OnePersonFilesOptions & { asked: number; lines: string[] } {
  const o = {
    hermesRoot: t.hermes,
    credentialsRoot: t.creds,
    workspaces: t.workspaces,
    agentHome: t.agentHome,
    asked: 0,
    lines: [] as string[],
    retryMs: 1,
    person: async () => {
      o.asked++;
      return person();
    },
    log: (_level: 'info' | 'warn', msg: string) => {
      o.lines.push(msg);
    },
  };
  return o;
}

describe('moveToOnePerson', () => {
  it('makes the person’s files the box’s and removes everyone else’s', async () => {
    const t = await tree();
    const o = options(t, async () => 'acc_mara');
    const result = await moveToOnePerson(o);
    expect(result.person).toBe('acc_mara');
    expect(o.asked).toBe(1);

    // Hermes: Mara's home is the root; her changed skill wins, the shared profile's fills in; memories merged once.
    expect(await ls(join(t.hermes, 'profiles'))).toEqual(['_feedback']);
    expect(await text(join(t.hermes, 'state.db'))).toBe('mara-sessions');
    expect(await ls(t.hermes)).toEqual(
      expect.arrayContaining(['auth.json', 'config.yaml', 'memories', 'pending', 'skills', 'state.db']),
    );
    expect(await ls(t.hermes)).not.toContain('.no-bundled-skills');
    expect(await text(join(t.hermes, 'skills/learned-a/SKILL.md'))).toBe('mara-a');
    expect(await text(join(t.hermes, 'skills/learned-b/SKILL.md'))).toBe('shared-b');
    expect(await text(join(t.hermes, 'skills/devops/deploy/SKILL.md'))).toBe('mara-deploy');
    expect(await ls(join(t.hermes, 'skills'))).toEqual(['.whombat', 'devops', 'learned-a', 'learned-b']);
    expect((await text(join(t.hermes, 'memories/MEMORY.md'))).split(SEP)).toEqual([
      'Mara drinks tea',
      'The NAS is shale',
      'Backups run at 3',
    ]);
    expect(await ls(join(t.hermes, 'pending'))).toEqual(['outside.json', 'person.json']);
    expect(JSON.parse(await text(join(t.hermes, 'pending/person.json')))).toEqual([
      { id: 's-1', attempts: 1 },
    ]);
    expect(JSON.parse(await text(join(t.hermes, 'pending/outside.json')))).toEqual([
      { id: 's-r', attempts: 0 },
    ]);

    // Sign-ins: one home per provider, Mara's; nobody else's.
    expect(await ls(t.creds)).toEqual(['claude', 'gateway', 'github']);
    expect(await text(join(t.creds, 'claude/config/.credentials.json'))).toBe('mara-claude');

    // The work folder is in the agent's home; the computers' folder is gone.
    expect(await text(join(t.agentHome, 'work/site/index.html'))).toBe('hello');
    expect(await ls(t.workspaces)).toEqual([]);

    // Once: a second start finds nothing to move and asks nobody.
    const again = options(t, async () => 'acc_mara');
    expect((await moveToOnePerson(again)).done).toEqual([]);
    expect(again.asked).toBe(0);
  });

  it('asks again until the server answers', async () => {
    const t = await tree();
    let calls = 0;
    const o = options(t, async () => {
      calls++;
      if (calls < 3) throw new Error('connect ECONNREFUSED');
      return 'acc_mara';
    });
    expect((await moveToOnePerson(o)).person).toBe('acc_mara');
    expect(o.asked).toBe(3);
    expect(o.lines.filter((l) => l.includes('waiting for the server'))).toHaveLength(2);
  });

  it('before a claim: the one account folder is the person’s; with several, the accounts’ files stay', async () => {
    const t = await tree();
    await rm(join(t.hermes, 'profiles/acc_joris'), { recursive: true });
    await rm(join(t.hermes, 'pending/acc_joris.json'));
    await rm(join(t.creds, 'acc_joris'), { recursive: true });
    expect(await accountFolders({ hermesRoot: t.hermes, credentialsRoot: t.creds })).toEqual(['acc_mara']);
    expect((await moveToOnePerson(options(t, async () => null))).person).toBe('acc_mara');
    expect(await ls(t.creds)).toEqual(['claude', 'gateway', 'github']);

    const u = await tree();
    const o = options(u, async () => null);
    expect((await moveToOnePerson(o)).person).toBeNull();
    expect(await ls(join(u.hermes, 'profiles'))).toEqual(['_feedback', '_shared', 'acc_joris', 'acc_mara']);
    expect(await ls(u.creds)).toEqual(['acc_joris', 'acc_mara', 'gateway', 'org']);
    expect(o.lines.some((l) => l.includes('until it is claimed'))).toBe(true);
    // The work folder isn't anyone's account: it moves anyway.
    expect(await text(join(u.agentHome, 'work/site/index.html'))).toBe('hello');
  });

  it('asks nobody on a box without the old layout', async () => {
    const dir = await tempDir();
    const o = options(
      {
        hermes: join(dir, 'h'),
        creds: join(dir, 'c'),
        workspaces: join(dir, 'w'),
        agentHome: join(dir, 'a'),
      },
      async () => 'acc_mara',
    );
    expect((await moveToOnePerson(o)).done).toEqual([]);
    expect(o.asked).toBe(0);
  });
});
