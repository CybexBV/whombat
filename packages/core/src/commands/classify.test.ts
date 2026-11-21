import { describe, expect, it } from 'vitest';
import {
  type ClassifyContext,
  COMMAND_CATEGORIES,
  COMMAND_CATEGORY_RANK,
  type CommandCategory,
  classifyCommand,
  commandCategoryKey,
  moreSevereCategory,
  normaliseCommand,
  shellSimpleCommands,
} from './index.js';

const ctx: ClassifyContext = {
  productionServers: [
    { name: 'web-1', host: 'web1.example.com', addresses: ['203.0.113.10', '2001:db8::10'] },
    { name: 'db-prod', host: 'db.example.com' },
  ],
};

/** `[command, category | null, target?]`: the target is checked when given. */
type Case = readonly [string, CommandCategory | null, (string | null)?];

const check = (cases: readonly Case[], context: ClassifyContext = ctx) => {
  for (const [command, category, target] of cases) {
    const found = classifyCommand(command, context);
    expect(found?.category ?? null, command).toBe(category);
    if (target !== undefined) expect(found?.target ?? null, `${command} → target`).toBe(target);
  }
};

describe('classifyCommand: production servers (AC-11, AC-40)', () => {
  it('finds ssh, scp, rsync and sftp to a production server by name, host or address', () => {
    check([
      ['ssh web-1', 'deploy_production', 'web-1'],
      ['ssh deploy@web1.example.com uptime', 'deploy_production', 'web-1'],
      ['ssh WEB1.EXAMPLE.COM.', 'deploy_production', 'web-1'],
      ['ssh -p 2222 -i ~/.ssh/k root@203.0.113.10', 'deploy_production', 'web-1'],
      ['ssh -p2222 -l root 203.0.113.10 ls', 'deploy_production', 'web-1'],
      ['ssh root@2001:db8::10', 'deploy_production', 'web-1'],
      ['ssh ssh://deploy@web1.example.com:2222', 'deploy_production', 'web-1'],
      ['ssh -J web-1 internal-box', 'deploy_production', 'web-1'],
      ['ssh -o ProxyJump=db.example.com other', 'deploy_production', 'db-prod'],
      ['ssh -o HostName=web1.example.com alias', 'deploy_production', 'web-1'],
      ['ssh web-1 -p 22 uptime', 'deploy_production', 'web-1'],
      ['ssh -- web-1 ls', 'deploy_production', 'web-1'],
      ['ssh "web-1" uptime', 'deploy_production', 'web-1'],
      ["ssh 'deploy'@web-1", 'deploy_production', 'web-1'],
      ['/usr/bin/ssh web-1', 'deploy_production', 'web-1'],
      ['scp dist.tgz web-1:/srv/', 'deploy_production', 'web-1'],
      ['scp -P 2222 -i key deploy@db.example.com:/var/backup.sql .', 'deploy_production', 'db-prod'],
      ['scp ./a.txt [2001:db8::10]:/tmp/', 'deploy_production', 'web-1'],
      ['scp scp://deploy@web1.example.com:22/srv/x .', 'deploy_production', 'web-1'],
      ['rsync -avz -e "ssh -p 22" ./ deploy@web1.example.com:/srv/app', 'deploy_production', 'web-1'],
      ['rsync -a ./ db.example.com::backups', 'deploy_production', 'db-prod'],
      ['rsync -a ./ rsync://web1.example.com/module/', 'deploy_production', 'web-1'],
      ['sftp web-1', 'deploy_production', 'web-1'],
      ['sftp -P 2222 deploy@db.example.com:/upload', 'deploy_production', 'db-prod'],
    ]);
  });

  it('matches a deploy tool naming a production server, and Docker or a database client reaching one', () => {
    check([
      ['fly deploy --remote-only web-1', 'deploy_production', 'web-1'],
      ['kubectl --context web-1 apply -f x.yml', 'deploy_production', 'web-1'],
      ['helm upgrade app ./chart --set host=web1.example.com', 'deploy_production', 'web-1'],
      ['docker -H ssh://web-1 ps', 'deploy_production', 'web-1'],
      ['DOCKER_HOST=ssh://deploy@web1.example.com docker compose up -d', 'deploy_production', 'web-1'],
      ['psql -h db.example.com -c "DROP DATABASE app"', 'deploy_production', 'db-prod'],
    ]);
  });

  it('leaves other servers and commands that only print the configuration alone', () => {
    check([
      ['ssh staging ls', null],
      ['ssh staging', null],
      ['ssh -G web-1', null],
      ['ssh -V', null],
      ['rsync -a ./ staging:/srv', null],
      ['scp ./a:b ./c', null],
      ['scp notes.txt /tmp/web-1.txt', null],
      ['ping web-1', null],
      ['curl https://web1.example.com/health', null],
      ['echo ssh web-1', null],
    ]);
  });

  it('wins over every other category', () => {
    check([
      ['git push origin main && ssh web-1 ./deploy.sh', 'deploy_production', 'web-1'],
      ['ssh web-1 "rm -rf /srv/app && git push origin main"', 'deploy_production', 'web-1'],
    ]);
  });

  it('is nothing without production servers', () => {
    check(
      [
        ['ssh web-1', null],
        ['scp a web-1:/srv', null],
        ['fly deploy web-1', 'deploy', null],
      ],
      {
        productionServers: [],
      },
    );
  });
});

describe('classifyCommand: pushes to the default branch', () => {
  it('finds refspecs that name main or master', () => {
    check([
      ['git push origin main', 'push_main', 'main'],
      ['git push origin HEAD:main', 'push_main', 'main'],
      ['git push origin feat/x:main', 'push_main', 'main'],
      ['git push -f origin +main', 'push_main', 'main'],
      ['git push --force origin main', 'push_main', 'main'],
      ['git push --force-with-lease=main:abc123 origin main', 'push_main', 'main'],
      ['git push origin refs/heads/master', 'push_main', 'master'],
      ['git push -u origin master', 'push_main', 'master'],
      ['git push origin :main', 'push_main', 'main'],
      ['git push --delete origin main', 'push_main', 'main'],
      ['git push --all origin', 'push_main', 'main'],
      ['git push --mirror backup', 'push_main', 'main'],
      ['git -C repo push origin main', 'push_main', 'main'],
      ['git -c push.default=current push origin main', 'push_main', 'main'],
      ['git push -o ci.skip origin main', 'push_main', 'main'],
      ['git push origin main # ship it', 'push_main', 'main'],
    ]);
  });

  it('leaves other branches and pushes whose branch the words don’t name', () => {
    check([
      ['git push origin feat/x', null],
      ['git push origin main:feat/x', null],
      ['git push origin mainline', null],
      ['git push', null],
      ['git push origin', null],
      ['git push origin HEAD', null],
      ['git pull origin main', null],
      ['git merge main', null],
      ['git checkout main', null],
      ['git push main', null],
    ]);
  });

  it('uses the context’s default branches', () => {
    const trunk = { productionServers: [], defaultBranches: ['trunk'] };
    check(
      [
        ['git push origin trunk', 'push_main', 'trunk'],
        ['git push origin main', null],
        ['git push --all origin', 'push_main', 'trunk'],
      ],
      trunk,
    );
  });
});

describe('classifyCommand: merges and deploys', () => {
  it('finds gh pr merge and the merge API', () => {
    check([
      ['gh pr merge 12 --squash', 'merge', null],
      ['gh pr merge --repo o/r 7', 'merge', 'o/r'],
      ['gh -R o/r pr merge feat/x', 'merge', 'o/r'],
      ['gh api -X PUT repos/o/r/pulls/3/merge', 'merge', 'o/r'],
      ['gh pr view 12', null],
      ['gh pr create --fill', null],
      ['gh api repos/o/r/pulls/3/merge', null],
    ]);
    expect(classifyCommand('gh pr merge 12 --squash', ctx)?.summary).toBe('Merge pull request #12');
    expect(classifyCommand('gh pr merge --repo o/r', ctx)?.summary).toBe('Merge a pull request in o/r');
  });

  it('leaves gh alone when gh goes through Whombat (agent-gh AGH-11)', () => {
    const through: ClassifyContext = { ...ctx, ghThroughWhombat: true };
    expect(classifyCommand('gh pr merge 12 --squash', through)).toBeNull();
    expect(classifyCommand('gh api -X PUT repos/o/r/pulls/3/merge', through)).toBeNull();
    // Everything else is still read: a push to main next to it is found.
    expect(classifyCommand('gh pr merge 12 && git push origin main', through)?.category).toBe('push_main');
  });

  it('finds the deploy tools of AC-40', () => {
    check([
      ['fly deploy', 'deploy', null],
      ['flyctl deploy --app billing', 'deploy', null],
      ['wrangler deploy', 'deploy'],
      ['wrangler publish', 'deploy'],
      ['wrangler pages deploy dist', 'deploy'],
      ['npx wrangler deploy', 'deploy'],
      ['npx -y wrangler@3 deploy', 'deploy'],
      ['pnpm dlx wrangler@3 pages deploy dist', 'deploy'],
      ['pnpm exec wrangler deploy', 'deploy'],
      ['bunx wrangler deploy', 'deploy'],
      ['vercel --prod', 'deploy'],
      ['vercel deploy --target=production', 'deploy'],
      ['netlify deploy --prod --dir dist', 'deploy'],
      ['kubectl apply -f k.yml', 'deploy'],
      ['kubectl -n prod delete pod x', 'deploy'],
      ['kubectl rollout restart deploy/api', 'deploy'],
      ['kubectl scale deploy/api --replicas=3', 'deploy'],
      ['helm upgrade --install api ./chart', 'deploy'],
      ['helm uninstall api', 'deploy'],
      ['terraform apply -auto-approve', 'deploy'],
      ['terraform -chdir=infra destroy', 'deploy'],
      ['tofu apply', 'deploy'],
      ['pulumi up --yes', 'deploy'],
      ['pulumi destroy', 'deploy'],
      ['docker push ghcr.io/o/api:1.2', 'deploy'],
      ['docker image push ghcr.io/o/api', 'deploy'],
      ['npm publish', 'deploy'],
      ['pnpm publish --access public', 'deploy'],
      ['yarn publish', 'deploy'],
      ['yarn npm publish', 'deploy'],
    ]);
    expect(classifyCommand('fly deploy', ctx)?.summary).toBe('Deploy with fly');
    expect(classifyCommand('npm publish', ctx)?.summary).toBe('Publish a package with npm');
    expect(classifyCommand('docker push x', ctx)?.summary).toBe('Push an image with docker');
  });

  it('leaves reading, building and previews alone', () => {
    check([
      ['vercel', null],
      ['vercel deploy', null],
      ['netlify deploy', null],
      ['kubectl get pods', null],
      ['kubectl rollout status deploy/api', null],
      ['kubectl rollout history deploy/api', null],
      ['helm list', null],
      ['helm template ./chart', null],
      ['terraform plan', null],
      ['pulumi preview', null],
      ['docker build -t api .', null],
      ['docker pull node:24', null],
      ['npm run deploy', null],
      ['npm install', null],
      ['fly status', null],
      ['wrangler dev', null],
    ]);
  });
});

describe('classifyCommand: destructive commands on other machines', () => {
  it('finds them over ssh, on any host', () => {
    check([
      ['ssh staging rm -rf /srv/app', 'destructive', 'staging'],
      ['ssh staging "rm -fr /srv/app"', 'destructive', 'staging'],
      ['ssh staging rm -r -f /srv/app', 'destructive', 'staging'],
      ['ssh staging rm --recursive --force /srv', 'destructive', 'staging'],
      ["ssh staging 'sudo systemctl stop nginx'", 'destructive', 'staging'],
      ['ssh staging systemctl disable --now api', 'destructive', 'staging'],
      ['ssh staging systemctl mask api', 'destructive', 'staging'],
      ['ssh staging \'psql -c "DROP TABLE users"\'', 'destructive', 'staging'],
      ['ssh staging "mysql -e \'drop database app\'"', 'destructive', 'staging'],
      ['ssh staging psql -c "TRUNCATE orders"', 'destructive', 'staging'],
      ['ssh staging docker compose -f x.yml down', 'destructive', 'staging'],
      ['ssh staging docker-compose down -v', 'destructive', 'staging'],
      ['ssh staging dd if=/dev/zero of=/dev/sda', 'destructive', 'staging'],
      ['ssh staging mkfs.ext4 /dev/sdb1', 'destructive', 'staging'],
      ['ssh staging \'bash -c "rm -rf /var/www"\'', 'destructive', 'staging'],
      ['ssh staging <<EOF\nrm -rf /var/www\nEOF', 'destructive', 'staging'],
      ["ssh staging bash -s <<'EOF'\nsystemctl stop api\nEOF", 'destructive', 'staging'],
    ]);
  });

  it('finds Docker on another machine and a database client dropping on another host', () => {
    check([
      ['docker -H ssh://staging ps', 'destructive', 'staging'],
      ['docker --host=tcp://10.0.0.5:2376 rm -f api', 'destructive', '10.0.0.5'],
      ['DOCKER_HOST=ssh://deploy@staging docker ps', 'destructive', 'staging'],
      ['export DOCKER_HOST=ssh://staging; docker ps', 'destructive', 'staging'],
      ['psql -h staging-db.internal -c "DROP TABLE x"', 'destructive', 'staging-db.internal'],
      ['psql postgres://u@staging-db/app -c "truncate t"', 'destructive', 'staging-db'],
    ]);
  });

  it('leaves the agent’s own computer alone (AC-40)', () => {
    check([
      ['rm -rf node_modules', null],
      ['sudo rm -rf /', null],
      ['docker compose down -v', null],
      ['sudo systemctl stop docker', null],
      ['psql -h localhost -c "DROP DATABASE app"', null],
      ['psql -c "DROP TABLE x"', null],
      ['docker -H unix:///var/run/docker.sock ps', null],
      ['dd if=/dev/zero of=/dev/null bs=1M count=1', null],
      ['cat <<EOF > script.sh\nrm -rf /\nEOF', null],
      ['ssh staging rm -r /tmp/x', null],
      ['ssh staging rm -f /tmp/x', null],
      ['ssh staging ls -la', null],
    ]);
  });
});

describe('classifyCommand: a command that runs on another machine (runsOn, CT-535)', () => {
  const on = (runsOn: string | null | undefined): ClassifyContext => ({ ...ctx, runsOn });

  it('counts destructive commands there, as over ssh', () => {
    check(
      [
        ['rm -rf /srv/backups', 'destructive', 'blackbox'],
        ['sudo rm -rf /srv/backups', 'destructive', 'blackbox'],
        ['cd /srv && rm -rf backups', 'destructive', 'blackbox'],
        ['systemctl stop nginx', 'destructive', 'blackbox'],
        ['git push origin main', 'push_main', 'main'],
        ['docker restart plex', null],
        ['systemctl restart nginx', null],
        ['docker ps', null],
      ],
      on('blackbox'),
    );
  });

  it('reads like ssh to that machine', () => {
    for (const command of [
      'rm -rf /srv/backups',
      'sudo systemctl stop nginx',
      'ls /srv; docker compose down',
      'git push origin HEAD:main',
      'sendmail ops@example.com < note.txt',
      'kubectl apply -f k.yml',
      'docker restart plex',
      'uptime',
    ]) {
      const there = classifyCommand(command, on('staging'));
      const over = classifyCommand(`ssh staging '${command}'`, ctx);
      expect([there?.category, there?.target], command).toEqual([over?.category, over?.target]);
    }
    expect(classifyCommand('uptime', on('web-1'))?.category).toBe('deploy_production');
  });

  it('is the agent’s own computer when absent or blank', () => {
    for (const runsOn of [undefined, null, '', '  '])
      expect(classifyCommand('rm -rf /srv/backups', on(runsOn)), String(runsOn)).toBeNull();
  });
});

describe('shellSimpleCommands: every simple command, for stricter readers (CT-535)', () => {
  const names = (command: string) => shellSimpleCommands(command).map((c) => [c.name, ...c.args].join(' '));

  it('looks through wrappers, splits compound commands and follows shells, ssh and substitutions', () => {
    expect(names('sudo -u root rm -rf /srv/backups')).toEqual(['rm -rf /srv/backups']);
    expect(names('cd /srv && FOO=1 timeout 5 nice -n 5 rm -rf backups; ls')).toEqual([
      'cd /srv',
      'rm -rf backups',
      'ls',
    ]);
    expect(names("bash -c 'zfs destroy tank/x'")).toEqual([
      'bash -c zfs destroy tank/x',
      'zfs destroy tank/x',
    ]);
    expect(names("ssh nas 'docker volume rm data'")).toContain('docker volume rm data');
    expect(names('echo $(rm -f /tmp/x)')).toEqual(['echo $(rm -f /tmp/x)', 'rm -f /tmp/x']);
    expect(names('find /srv -name "*.log" | xargs -0 rm')).toEqual(['find /srv -name *.log', 'rm']);
    expect(shellSimpleCommands('psql <<EOF\nDROP TABLE x\nEOF')[0]?.stdin).toEqual(['DROP TABLE x']);
  });

  it('names the files a redirection writes over, not appends, descriptors or /dev/null', () => {
    const truncates = (command: string) => shellSimpleCommands(command).flatMap((c) => c.truncates);
    expect(truncates('echo hi > /etc/motd')).toEqual(['/etc/motd']);
    expect(truncates('cat x >| a; ls &> b; echo y >& c')).toEqual(['a', 'b', 'c']);
    expect(truncates('> /var/log/syslog')).toEqual(['/var/log/syslog']);
    expect(truncates('echo hi >> /etc/motd')).toEqual([]);
    expect(truncates('ls > /dev/null 2>&1; ls &>/dev/null; ls >&2; ls &>> log; ls 2>/dev/null')).toEqual([]);
    expect(truncates('echo "a > b" \'c > d\'')).toEqual([]);
  });

  it('never throws', () => {
    for (const odd of ['', "'", 'a $(', '<<', '>', ')(', '\\'])
      expect(() => shellSimpleCommands(odd), odd).not.toThrow();
  });
});

describe('classifyCommand: messages to the outside world', () => {
  it('finds mail tools and the webhook hosts', () => {
    check([
      [
        'curl -X POST https://hooks.slack.com/services/T/B/X -d @m.json',
        'message_external',
        'hooks.slack.com',
      ],
      ['curl -d "{}" "https://discord.com/api/webhooks/1/abc"', 'message_external', 'discord.com'],
      [
        'curl https://api.telegram.org/bot123:ABC/sendMessage?chat_id=1',
        'message_external',
        'api.telegram.org',
      ],
      ['wget -qO- https://outlook.office.com/webhook/abc', 'message_external', 'outlook.office.com'],
      [
        'http POST https://acme.webhook.office.com/webhookb2/abc text=hi',
        'message_external',
        'acme.webhook.office.com',
      ],
      ['sendmail -t < mail.txt', 'message_external', null],
      ['sendmail ops@example.com < mail.txt', 'message_external', 'ops@example.com'],
      ['mail -s hi bob@example.com < body', 'message_external', 'bob@example.com'],
      ['swaks --to a@example.com --server smtp.example.com', 'message_external', 'a@example.com'],
    ]);
  });

  it('leaves other requests and local mail alone', () => {
    check([
      ['curl https://example.com', null],
      ['curl https://api.telegram.org/bot123:ABC/getUpdates', null],
      ['curl https://discord.com/channels/1', null],
      ['mail root < body', null],
      ['echo https://hooks.slack.com/services/T/B/X', null],
    ]);
  });
});

describe('classifyCommand: reading the shell', () => {
  it('splits compound commands and reads substitutions', () => {
    check([
      ['cd app && npm test && git push origin main', 'push_main'],
      ['npm test || git push origin main', 'push_main'],
      ['npm test; git push origin main', 'push_main'],
      ['make build | tee log & fly deploy', 'deploy'],
      ['npm test\ngit push origin main', 'push_main'],
      ['(cd infra && terraform apply)', 'deploy'],
      ['echo $(ssh web-1 hostname)', 'deploy_production'],
      ['echo "built at $(git push origin main)"', 'push_main'],
      ['echo `git push origin main`', 'push_main'],
      ['echo hi > /dev/null 2>&1 && git push origin main', 'push_main'],
      ['git push origin main 2>&1 | tee push.log', 'push_main'],
      ['if true; then git push origin main; fi', 'push_main'],
      ['for f in a b; do ssh web-1 ls; done', 'deploy_production'],
      ['{ fly deploy; }', 'deploy'],
    ]);
  });

  it('looks through sudo, env, nohup, time, timeout, xargs and shells', () => {
    check([
      ['sudo ssh web-1', 'deploy_production'],
      ['sudo -u deploy -E git push origin main', 'push_main'],
      ['sudo --user=deploy fly deploy', 'deploy'],
      ['env FOO=1 git push origin main', 'push_main'],
      ['env -i PATH=/bin git push origin main', 'push_main'],
      ['env -S "git push origin main"', 'push_main'],
      ['FOO=1 BAR=2 git push origin main', 'push_main'],
      ['nohup fly deploy &', 'deploy'],
      ['time git push origin main', 'push_main'],
      ['timeout 30 ssh web-1 ls', 'deploy_production'],
      ['timeout -s KILL 5m fly deploy', 'deploy'],
      ['nice -n 10 fly deploy', 'deploy'],
      ['xargs -I{} ssh web-1 {}', 'deploy_production'],
      ['exec fly deploy', 'deploy'],
      ["bash -c 'git push origin main'", 'push_main'],
      ["sh -c 'fly deploy'", 'deploy'],
      ["bash -lc 'ssh web-1 ls'", 'deploy_production'],
      ["sudo -u deploy env FOO=1 bash -lc 'ssh web-1 ls'", 'deploy_production'],
      ['bash <<EOF\ngit push origin main\nEOF', 'push_main'],
      ['bash <<< "git push origin main"', 'push_main'],
      ['npx -c "fly deploy"', 'deploy'],
    ]);
  });

  it('doesn’t take quoted text, comments or lookups for commands', () => {
    check([
      ['echo "fly deploy"', null],
      ["echo 'git push origin main'", null],
      ["grep 'git push origin main' file", null],
      ['grep -r "ssh web-1" .', null],
      ['# git push origin main', null],
      ['git status # then git push origin main', null],
      ['command -v ssh', null],
      ['which fly', null],
      ['man git-push', null],
      ['printf "%s\\n" "kubectl apply -f x"', null],
      ['echo $((1 + 2))', null],
      ['cat README.md', null],
      ['unterminated "quote ssh web-1', null],
      ['', null],
      ['   ', null],
    ]);
  });

  it('never throws, whatever it reads', () => {
    for (const weird of [
      '"',
      "'",
      '$(',
      '`',
      '\\',
      '<<',
      '<<EOF',
      ')(',
      '&&&',
      '|||',
      '$(ssh web-1',
      '${',
      'a=$(b',
    ])
      expect(() => classifyCommand(weird, ctx)).not.toThrow();
    expect(classifyCommand('$(ssh web-1', ctx)?.category).toBe('deploy_production');
  });

  it('gives the most severe category and the first match of it', () => {
    check([
      ['fly deploy && git push origin main', 'push_main'],
      ['gh pr merge 1 && fly deploy', 'merge'],
      ['curl https://hooks.slack.com/services/x && ssh staging rm -rf /x', 'destructive'],
      ['fly deploy; npm publish', 'deploy'],
    ]);
    expect(classifyCommand('git push origin master; git push origin main', ctx)?.target).toBe('master');
  });
});

describe('command categories (AC-41)', () => {
  it('map to their keys', () => {
    expect(COMMAND_CATEGORIES.map((c) => [c, commandCategoryKey(c)])).toEqual([
      ['deploy', 'deploy'],
      ['deploy_production', 'deploy.production'],
      ['merge', 'merge.main'],
      ['push_main', 'branch.main.push'],
      ['destructive', 'commands.destructive'],
      ['message_external', 'messages.external'],
      ['web', 'web.browse'],
      ['browser', 'browser.use'],
    ]);
  });

  it('rank by severity', () => {
    expect(COMMAND_CATEGORY_RANK).toEqual([
      'deploy_production',
      'push_main',
      'merge',
      'deploy',
      'destructive',
      'message_external',
      'browser',
      'web',
    ]);
    expect(new Set(COMMAND_CATEGORY_RANK)).toEqual(new Set(COMMAND_CATEGORIES));
    expect(moreSevereCategory('deploy', 'push_main')).toBe('push_main');
    expect(moreSevereCategory('destructive', 'message_external')).toBe('destructive');
  });

  it('normalise commands for allowances (AC-42)', () => {
    expect(normaliseCommand('  fly   deploy\n --app  x\t')).toBe('fly deploy --app x');
    expect(normaliseCommand('git push origin main')).toBe('git push origin main');
    expect(normaliseCommand('rm -rf "a b"')).not.toBe(normaliseCommand('rm -rf a b'));
  });
});
