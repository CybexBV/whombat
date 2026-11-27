import { treeCatalogs } from '../../tree';

/**
 * What each diagnostic file part holds, as Diagnostics lists them (`managed/diagnostics.ts`). English is the
 * contracts' `DIAGNOSTIC_SCOPES`, word for word.
 */
export const DIAGNOSTICS_WORDS = treeCatalogs(
  'hostManaged.diagnostics',
  {
    scopes: {
      versions:
        'Runtime, database schema and protocol versions, the running release id, provider CLI versions.',
      health:
        'Runtime health (status, check names with ok/failed, external states), uptime, draining/quarantine, claim and recovery-kit flags, revocation counts, provider sign-in states by provider and mode (no whose, no labels).',
      updates:
        'The update journal summary: state, current/known-good/candidate release ids, hold, read-only, failure and wait codes, last check, the client security floor.',
      backup:
        'Backup state, coverage classes, last success and age, last failure time and stage (no reason text, no destination), restore-drill result.',
      connectivity:
        'Relay connection state, last connection time and error code, active sessions, and 7-day counters of relay connects/disconnects and sessions opened/refused.',
      errors: 'Session error codes and application codes counted per operation name over 7 days.',
    },
  },
  {
    scopes: {
      versions:
        'Versies van de runtime, het databaseschema en het protocol, de id van de draaiende release, versies van de CLI’s van providers.',
      health:
        'Gezondheid van de runtime (status, namen van controles met ok/mislukt, externe toestanden), uptime, leeglopen/quarantaine, vlaggen voor koppelen en het herstelpakket, aantallen ingetrokken apparaten, inlogstatus per provider en modus (niet van wie, geen labels).',
      updates:
        'Samenvatting van het updatelogboek: toestand, release-id’s (huidig, laatst goed, kandidaat), pauze, alleen-lezen, fout- en wachtcodes, laatste controle, de minimale veilige appversie.',
      backup:
        'Back-upstatus, dekkingsklassen, laatste geslaagde back-up en hoe oud die is, tijd en stap van de laatste fout (geen reden, geen bestemming), resultaat van de hersteloefening.',
      connectivity:
        'Status van de relayverbinding, tijd en foutcode van de laatste verbinding, actieve sessies, en tellers over 7 dagen van verbindingen met de relay en geopende/geweigerde sessies.',
      errors: 'Foutcodes van sessies en de app, geteld per bewerking over 7 dagen.',
    },
  },
);
