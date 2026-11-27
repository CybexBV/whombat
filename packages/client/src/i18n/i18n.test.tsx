// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import type { NeedsYouItem } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import { agentFaceLabelIn, agentFaceStyleIn } from '../agentFace';
import { agentWords } from '../agentName';
import { permissionsText, serverPermission } from '../agentPermissions';
import { connectionWords } from '../connections/words';
import { arrangeWords, overviewPageWords } from '../home/arrange';
import { homeGreeting, homeStatus, homeWidgetStatus, widgetAsOfLabel } from '../home/greeting';
import { quietEndWords } from '../home/monitoring';
import {
  needsYouApprovalCard,
  needsYouGroupLabel,
  needsYouListRow,
  needsYouListView,
  needsYouMore,
  needsYouSettledText,
  needsYouWords,
} from '../home/needsYouList';
import { usedPhrase } from '../home/sections';
import { statusSummary } from '../home/statusLevel';
import { overviewWords } from '../home/tabs';
import { headFacts, thingTabs } from '../home/thingPage';
import { needsYouWhen, untilText } from '../home/time';
import { widgetFooter } from '../home/widgets';
import { formatAgo, formatDuration, hostRangeWords } from '../hosts/format';
import { overviewServersLine } from '../hosts/overview';
import { formatEuro, planCardText } from '../managed/billing';
import { claimAppliance } from '../managed/claim';
import { licenceDay } from '../managed/licence';
import { pushText } from '../managed/push';
import { updateStateWords, updateText, whatsNewText } from '../managed/updates';
import { daysText, dndSetText, quietHoursText } from '../notifications';
import { settingsGroupText, settingsHomeRows, themeWords } from '../settingsGroups';
import { teamReportWords } from '../teamReports';
import { usageCost, usageView } from '../usageView';
import { countryName, newsSuggestedTitle, placeRowText } from '../weatherNews';
import { createCatalogHook, I18nProvider, useI18n } from './react';

describe('@whombat/client i18n', () => {
  it('draws Dutch Inbox groups, times, actions and approval cards', () => {
    const options = {
      locale: 'nl-NL',
      now: Date.parse('2026-10-02T14:00:00Z'),
      timeZone: 'Europe/Amsterdam',
      assistant: 'Dusty',
    };
    const approval: NeedsYouItem = {
      id: 'approval:1',
      ref: { kind: 'approval', id: '1' },
      kind: 'approval',
      group: 'you',
      severity: 'warn',
      title: 'Server opnieuw opstarten?',
      body: 'De server is kort offline.',
      at: '2026-10-01T14:00:00Z',
      actions: [
        { id: 'approve', kind: 'approve', style: 'primary', label: 'Yes, do it' },
        {
          id: 'later',
          kind: 'approve_later',
          style: 'secondary',
          label: 'Tonight',
          at: '2026-10-03T01:00:00Z',
        },
        { id: 'decline', kind: 'decline', style: 'secondary', label: 'No' },
      ],
    };
    const reminder: NeedsYouItem = {
      ...approval,
      id: 'hint:1',
      ref: { kind: 'hint', id: '1' },
      kind: 'hint',
      group: 'fyi',
      actions: [],
    };
    const inbox = needsYouListView({ needsYou: [], needsYouList: [approval, reminder] }, options);
    expect(inbox.groups.map(({ label }) => label)).toEqual(['Actie nodig', 'Meldingen', 'Afgehandeld']);
    expect(inbox.groups.find(({ key }) => key === 'fyi')?.fold).toMatchObject({ show: 'Toon 1 melding' });
    expect(inbox.groups[0]?.rows[0]?.meta).toBe('1 dag geleden');

    const row = needsYouListRow(approval, options);
    expect(row.buttons.filter((button) => !button.more).map(({ label }) => label)).toEqual([
      'Ja, nu',
      'Ja, vannacht',
      'Nee',
    ]);
    expect(needsYouMore(row, options.locale).map(({ label }) => label)).toEqual(['Praat met Dusty hierover']);
    expect(needsYouSettledText(approval.ref, options.locale)).toBe(needsYouWords(options.locale).settledOwn);
    expect(needsYouApprovalCard(row, options)).toMatchObject({
      status: 'Dusty heeft je akkoord nodig',
      permission: 'Niet opgegeven in dit verzoek',
      tonight: { label: 'Ja, vannacht', at: 'zaterdag 3 oktober 2026 om 03:00 · Europe/Amsterdam' },
    });
  });

  it('translates Overview, arranging, updates and team reports into Dutch', () => {
    const locale = 'nl-NL';
    expect(overviewPageWords(locale).watching('Dusty', 1, 2)).toBe(
      'Dusty houdt 1 server en 2 koppelingen in de gaten.',
    );
    expect(overviewPageWords(locale).todayLine(1, 2)).toBe('1 ding tot nu toe · 2 gepland');
    expect(arrangeWords(locale)).toMatchObject({
      arrange: 'Indelen',
      ownNames: { needsYou: 'Actie nodig' },
      ranges: { '24h': '24 uur' },
    });
    expect(updateStateWords(locale)).toEqual({ upToDate: 'Bijgewerkt', ready: 'Update klaar' });
    expect(updateText(locale).blocker(2, 'backup')).toBe('2 back-ups bezig');
    expect(whatsNewText(locale).link).toBe('Wat is er nieuw?');
    expect(teamReportWords(locale)).toMatchObject({
      entry: 'Meld een probleem of idee',
      title: 'Jouw meldingen',
    });
  });

  it('translates agent, settings and permissions copy into Dutch while keeping English defaults', () => {
    expect(agentWords('Dusty').ask).toBe('Ask Dusty');
    expect(agentWords('Dusty', 'nl-NL').ask).toBe('Vraag Dusty');
    expect(agentWords(null, 'nl').name).toBe('je assistent');

    expect(agentFaceLabelIn('neo', 'nl-NL')).toBe('Gezicht van Neo');
    expect(agentFaceStyleIn('dusty', 'nl-NL')).toContain('geen jargon');

    expect(settingsGroupText('nl-NL').groups('Dusty')).toMatchObject({
      you: 'Jij',
      agent: 'Dusty',
      connections: 'Koppelingen',
      appliance: 'Deze Whombat',
      news: 'Nieuws en weer',
      advanced: 'Geavanceerd',
    });
    expect(themeWords('nl-NL').choices).toEqual({ light: 'Licht', dark: 'Donker', system: 'Systeem' });
    const rows = settingsHomeRows('Dusty', ['profile', 'notifications'], ['profile', 'may'], 'nl-NL');
    expect(rows[0]?.title).toBe('Jij');
    expect(rows[1]?.line).toBe('Naam en gezicht · Wat Dusty mag doen');

    const perm = serverPermission({ id: 'srv_1', name: 'pve-01', asksFirst: 'risky' }, 'Dusty', 'nl-NL');
    expect(perm.line).toContain('vraagt het je');
    expect(permissionsText('Dusty', 'nl-NL').didTitle).toBe('Alles wat Dusty deed');
    expect(connectionWords('Dusty', { locale: 'nl-NL' }).mayDo).toBe('WAT DUSTY MAG DOEN');
  });

  it('handles Dutch country articles and place copy accurately', () => {
    expect(countryName('NL', { the: true }, 'en-GB')).toBe('the Netherlands');
    expect(countryName('NL', { the: true }, 'nl-NL')).toBe('Nederland');
    expect(countryName('US', { the: true }, 'nl-NL')).toBe('de Verenigde Staten');
    expect(countryName('GB', { the: true }, 'nl-NL')).toBe('het Verenigd Koninkrijk');
    expect(
      newsSuggestedTitle(
        { name: 'Amsterdam', country: 'NL', lat: 52.37, lon: 4.89, guessed: false },
        'nl-NL',
      ),
    ).toBe('Voorgesteld voor Nederland');
    expect(placeRowText(null, 'nl-NL')).toBe('Niet ingesteld');
  });

  it('localizes notifications, home status, inbox, widgets, hosts and billing', () => {
    const now = new Date('2026-10-01T14:00:00Z');
    expect(daysText(['mon', 'tue', 'fri'], 'nl-NL')).toBe('ma, di en vr');
    expect(
      quietHoursText(
        { enabled: true, days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '22:00', end: '08:00' },
        'nl-NL',
      ),
    ).toBe('Werkdagen, 22:00–08:00 (tot de volgende ochtend)');
    expect(dndSetText('2026-10-02T07:00:00Z', now, 'Europe/Amsterdam', 'nl-NL')).toBe(
      'Niet storen tot morgen om 09:00.',
    );

    expect(homeGreeting('John', now, 'Europe/Amsterdam', 'nl-NL')).toBe('Goedemiddag, John');
    const st = homeStatus(
      { summary: { needsYou: 0, working: 0, problems: 0 } },
      { timeZone: 'Europe/Amsterdam', locale: 'nl-NL' },
    );
    expect(st.parts[0]?.text).toBe('Alles in orde. Er is niets dat je nodig heeft.');

    const widget = homeWidgetStatus(
      { summary: { needsYou: 2, working: 0, problems: 0 } },
      { timeZone: 'Europe/Amsterdam', now, locale: 'nl-NL' },
    );
    expect(widget.status).toBe('2 dingen hebben je nodig');
    expect(widgetAsOfLabel(widget, now, 'nl-NL')).toBe('van 16:00');

    expect(untilText('2026-10-02T07:00:00Z', now, 'Europe/Amsterdam', 'nl-NL')).toBe('tot morgen 09:00');
    expect(quietEndWords('2026-10-02T07:00:00Z', now, 'Europe/Amsterdam', 'nl-NL')).toBe('morgen 09:00');
    expect(needsYouWhen('2026-09-29T10:00:00Z', now, 'Europe/Amsterdam', 'nl-NL')).toBe('2 dagen geleden');
    expect(usedPhrase('2026-10-01T10:00:00Z', now, 'Europe/Amsterdam', 'nl-NL')).toBe('vandaag gebruikt');
    expect(statusSummary(['notWorking', 'connected', 'needsLook'], 0, 'nl-NL')).toBe(
      '1 werkt niet · 1 verbonden · 1 vraagt aandacht',
    );
    expect(overviewWords('nl-NL').lookIntoIt).toBe('Bekijk het');
    expect(needsYouWords('nl-NL').settle).toBe('Afhandelen');
    expect(needsYouGroupLabel('you', { Name: 'Dusty' }, 'nl-NL')).toBe('Actie nodig');
    expect(widgetFooter({ fromConversationId: 'c1', refreshSec: 300 }, 'nl-NL')).toContain('elke 5 minuten');

    // Bilingual headFacts recognizes both English Checked and Dutch Gecontroleerd.
    const checkedNl = [{ text: 'Gecontroleerd 2 min geleden' }];
    const verFact = [{ text: 'Versie 1.2' }];
    expect(headFacts([checkedNl, verFact])).toEqual({ checked: checkedNl, detail: [verFact] });
    expect(thingTabs({ tabs: [], settings: true }, 'nl-NL').map((t) => t.label)).toEqual([
      'Activiteit',
      'Koppeling',
    ]);

    expect(formatAgo(180, 'nl-NL')).toBe('3\u00a0min geleden');
    expect(formatDuration(3720, 'nl-NL')).toBe('1\u00a0u 2\u00a0min');
    expect(hostRangeWords('nl-NL')['24h']).toBe('Afgelopen 24 uur');
    expect(overviewServersLine([], 'nl-NL')).toBe('');

    expect(formatEuro(149000, 'nl-NL')).toBe('€1.490');
    expect(planCardText({ name: 'Pro', amountCents: 4900, limits: { connectors: null } }, 'nl-NL')).toEqual({
      name: 'Pro',
      price: '€49 per Whombat per maand',
      extras: 'Onbeperkt koppelingen',
    });
    expect(licenceDay('2026-10-12T00:00:00Z', 'UTC', 'nl-NL')).toBe('12 oktober 2026');
    expect(pushText('nl-NL').approval).toBe('Er wacht iets op jouw goedkeuring');

    expect(usageCost(12.5, 'nl-NL')).toBe('$12,50');
    expect(usageCost(0.005, 'nl-NL')).toBe('minder dan $0,01');
    const uv = usageView(
      {
        generatedAt: '2026-10-01T11:22:00Z',
        timeZone: 'Europe/Amsterdam',
        totals: {
          today: {
            turns: 2,
            costTurns: 2,
            unreportedTurns: 0,
            costUsd: 0.42,
            inputTokens: 1000,
            outputTokens: 500,
          },
          week: {
            turns: 0,
            costTurns: 0,
            unreportedTurns: 0,
            costUsd: null,
            inputTokens: 0,
            outputTokens: 0,
          },
          month: {
            turns: 0,
            costTurns: 0,
            unreportedTurns: 0,
            costUsd: null,
            inputTokens: 0,
            outputTokens: 0,
          },
        },
        plans: [],
      },
      'Dusty',
      'nl-NL',
    );
    expect(uv.title).toBe('Verbruik');
    expect(uv.windows.today.cost).toBe('$0,42');
  });

  it('provides I18nProvider, createCatalogHook and rich slot rendering without innerHTML', () => {
    const useDemoT = createCatalogHook({
      en: { greet: 'Open {link} to confirm {name}.' },
      nl: { greet: 'Bevestig {name} via {link}.' },
    });

    function Probe() {
      const { locale, language, formatCurrency } = useI18n();
      const t = useDemoT();
      return (
        <div>
          <span data-testid="meta">{`${language}:${locale}:${formatCurrency(123456, 'EUR')}`}</span>
          <p data-testid="rich">
            {t.tx('greet', {
              link: <a href="/ok">Settings</a>,
              name: <strong>Dusty</strong>,
            })}
          </p>
        </div>
      );
    }

    render(
      <I18nProvider locale="nl-NL">
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('meta').textContent).toBe('nl:nl-NL:€1.234,56');
    expect(screen.getByTestId('rich').textContent).toBe('Bevestig Dusty via Settings.');
  });

  it('gates claim locale on session protocol minor >= 20 so older boxes never see an unknown field', async () => {
    const sentPayloads: unknown[] = [];
    const runWithMinor = async (minor: number) => {
      sentPayloads.length = 0;
      // Fake session returning protocol { major: 5, minor } and failing right after claim invoke so we inspect payload.
      const fakeSession = {
        state: () => ({
          status: 'open' as const,
          info: {
            protocol: { major: 5, minor },
            capabilities: [],
            appliance: { id: 'p1', name: null },
            account: null,
            endpointId: null,
            authzGeneration: 0,
            clearCache: false,
            channel: 'enroll' as const,
            direct: null,
            edition: 'commercial' as const,
          },
        }),
        invoke: vi.fn(async (op: string, input: unknown) => {
          if (op === 'enroll.claim.begin') {
            // Return valid ristretto255 basepoint (32 bytes) isn't needed if we catch ClaimMismatchError;
            // instead mock claimBegin failure? Wait: we want to reach enroll.claim.
            // Use real claimPakeResponder to produce a valid share!
            const { claimPakeResponder } = await import('@whombat/protocol/claim');
            const req = input as { claimId: string; method: 'code'; share: string };
            const resp = claimPakeResponder(
              {
                method: 'code',
                password: 'KXQM',
                deviceId: 'dev_1',
                appliancePeerId: 'peer_app',
                clientPeerId: 'peer_cli',
                claimId: req.claimId,
              },
              req.share,
              (n) => crypto.getRandomValues(new Uint8Array(n)),
            );
            return { status: 200, body: { share: resp.share }, requestId: 'r1' };
          }
          if (op === 'enroll.claim') {
            sentPayloads.push(input);
            throw new Error('stop-after-capture');
          }
          throw new Error(`unexpected op ${op}`);
        }),
        close: vi.fn(),
      };
      await expect(
        claimAppliance({
          control: {
            startClaim: vi.fn(async () => ({
              claim: { claim: 'clm_12345678', device: 'dev_1', contentPeerId: 'peer_app' },
            })),
          } as never,
          orgId: 'org_1',
          request: { method: 'code', device: 'dev_1', letters: 'KXQM' },
          terms: { version: '2026-01-01' },
          openSession: vi.fn(async () => fakeSession as never),
          clientPeerId: 'peer_cli',
          account: { name: 'John', email: 'john@example.com' },
          endpoint: { label: 'Chrome', platform: 'web' },
          locale: 'nl-NL',
        }),
      ).rejects.toThrow('stop-after-capture');
      return sentPayloads[0] as Record<string, unknown>;
    };

    const oldPayload = await runWithMinor(19);
    expect(oldPayload).not.toHaveProperty('locale');

    const newPayload = await runWithMinor(20);
    expect(newPayload.locale).toBe('nl-NL');
  });
});
