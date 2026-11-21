/**
 * `whombat`: the runtime bundle's `bin/whombat`, which the appliance's update helper runs for the database
 * (docs/decisions/managed-db.md MD-10; hermes-engine.md HE-48: the self-hosted commands went with self-hosted mode).
 * Thin: argument parsing and printing; the work is in `schema.ts`.
 */
import { parseArgs } from 'node:util';
import { CliError } from './errors';

export const USAGE = `whombat — the database commands of a Whombat runtime

Usage: whombat <command> [options]

  schema-check         can this version use the database? Read-only; changes nothing
                       exit 0 read-write, 10 migration required, 11 read-only, 12 refused
  migrate              apply the database migrations now
                       exit 0 ok, 11 read-only, 12 refused, 13 checkpoint required, 14 lock timeout
      --checkpoint <ref>      the backup taken with writes stopped: needed for migrations that narrow
                              which versions may write (contract/incompatible)
  version              this Whombat's version, commit and schema (also --version)

  --json               a machine-readable answer
  --env                the database from DATABASE_URL, else WHOMBAT_ENV_FILE (the only source there is)
`;

type Out = (text: string) => void;

const print: Out = (t) => process.stdout.write(t.endsWith('\n') ? t : `${t}\n`);
const printErr: Out = (t) => process.stderr.write(t.endsWith('\n') ? t : `${t}\n`);

async function cmdVersion(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' } } });
  const { buildInfo, versionLine } = await import('@whombat/server/host');
  const build = buildInfo();
  if (values.json) {
    print(JSON.stringify({ ...build, node: process.versions.node }));
    return 0;
  }
  print(`whombat ${versionLine(build)} · schema ${build.schema ?? '?'} · node ${process.versions.node}`);
  return 0;
}

async function cmdMigrate(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean' }, checkpoint: { type: 'string' }, env: { type: 'boolean' } },
  });
  const { migrateCommand, targetFromEnv } = await import('./schema');
  const out = await migrateCommand(targetFromEnv(), {
    json: values.json === true,
    checkpoint: values.checkpoint,
    log: print,
  });
  (out.code === 0 || values.json ? print : printErr)(out.text);
  return out.code;
}

async function cmdSchemaCheck(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean' }, env: { type: 'boolean' } },
  });
  const { schemaCheckCommand, targetFromEnv } = await import('./schema');
  const out = await schemaCheckCommand(targetFromEnv(), values.json === true);
  print(out.text);
  return out.code;
}

/** Runs one command; resolves with the exit code. */
export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command !== undefined && (args.includes('--help') || args.includes('-h'))) {
    print(USAGE);
    return 0;
  }
  try {
    switch (command) {
      case 'version':
      case '--version':
      case '-v':
        return await cmdVersion(args);
      case 'migrate':
        return await cmdMigrate(args);
      case 'schema-check':
        return await cmdSchemaCheck(args);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        print(USAGE);
        return command === undefined ? 2 : 0;
      default:
        printErr(`Unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof CliError) {
      printErr(err.message);
      if (err.fix) printErr(`Fix: ${err.fix}`);
      return 1;
    }
    if (err instanceof TypeError && (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      printErr(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    throw err;
  }
}
