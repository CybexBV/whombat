#!/usr/bin/env python3
"""Run the complete runtime check, or compare exact-source CI timing reports."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import unit_selection


ROOT = Path(__file__).resolve().parents[2]
REPORTS = ROOT / 'ci-reports'
SCHEMA = 1


def worker_count(value):
    if not isinstance(value, str) or not value.isascii() or not value.isdecimal():
        raise ValueError('VITEST_MAX_WORKERS must be an integer from 1 through 8')
    workers = int(value)
    if not 1 <= workers <= 8:
        raise ValueError('VITEST_MAX_WORKERS must be an integer from 1 through 8')
    return workers


# Packages typechecked at once. The local `pnpm typecheck` checks every package together (about 17 GB at its peak); the
# 12 GB guest was killed in it, while four at a time peak at about 9 GB.
TYPECHECK_CONCURRENCY = 4


def phases():
    # pnpm 12 auto-installs before package scripts, so the single explicit frozen install comes first. The unit phase
    # covers every package (runtime, apps and contracts); the contracts' generated files and Go module follow.
    return [
        ('install', ['pnpm', 'install', '--frozen-lockfile', '--store-dir', '/srv/whombat-ci/cache/pnpm']),
        ('lint', ['pnpm', 'lint']),
        ('notices', ['pnpm', 'notices', '--check']),
        ('types', ['pnpm', '-r', '--workspace-concurrency=' + str(TYPECHECK_CONCURRENCY), 'typecheck']),
        ('types-root', ['pnpm', 'exec', 'tsc', '-p', 'tsconfig.json']),
        ('unit', ['pnpm', 'exec', 'vitest', 'run', '--reporter=default', '--reporter=json',
                  '--outputFile=' + str(REPORTS / 'unit-results.json')]),
        ('server', ['pnpm', '--filter', '@whombat/server', 'exec', 'vitest', 'run',
                    '--config', 'vitest.int.config.ts', '--reporter=default', '--reporter=json',
                    '--outputFile=' + str(REPORTS / 'server-results.json')]),
        # The CLI's `schema-check` and `migrate` on a throwaway database: the appliance runs both at every start.
        ('cli', ['pnpm', '--filter', '@whombat/cli', 'exec', 'vitest', 'run', '--config', 'vitest.int.config.ts']),
        ('soak', ['pnpm', 'soak:managed', '--minutes', '2', '--max-growth-mb', '40']),
        ('contracts-generated', ['pnpm', 'contracts:gen:check']),
        ('contracts-go', ['pnpm', 'contracts:test:go']),
        # Our Hermes plugin's tests on the pinned Hermes, installed fresh as the appliance installs it.
        ('hermes', ['python3', 'packages/hermes-whombat/scripts/test.py', '--hermes', 'pin']),
        ('ci-contract', ['python3', '-m', 'unittest', 'discover', '-s', 'scripts/ci', '-p', 'test_*.py']),
    ]


def test_evidence(path):
    value = json.loads(path.read_text())
    identities = []
    files = []
    for suite in value['testResults']:
        name = str(suite['name'])
        if name.startswith(str(ROOT) + '/'):
            name = name[len(str(ROOT)) + 1:]
        assertions = suite['assertionResults']
        identities.extend((name, item['fullName'], item['status']) for item in assertions)
        files.append({'file': name, 'seconds': max(0, suite['endTime'] - suite['startTime']) / 1000,
                      'tests': len(assertions), 'status': suite['status']})
    identities.sort()
    return {'passed': value['numPassedTests'], 'failed': value['numFailedTests'],
            'pending': value['numPendingTests'], 'total': value['numTotalTests'],
            'identity_sha256': hashlib.sha256(json.dumps(identities).encode()).hexdigest(),
            'files': sorted(files, key=lambda item: item['seconds'], reverse=True)}


def save(report):
    temporary = REPORTS / 'check-timings.json.next'
    temporary.write_text(json.dumps(report, indent=2) + '\n')
    temporary.replace(REPORTS / 'check-timings.json')


def test_schedule(workers, cpus, memory_bytes):
    # Eight-worker jobs get two bounded four-worker pools. Ordinary four-vCPU jobs retain their measured default.
    parallel = workers >= 8 and cpus >= 8 and memory_bytes >= 10 * 1024 ** 3
    return {'parallel': parallel, 'workers_per_suite': workers // 2 if parallel else workers}


def available_resources():
    cpus = os.cpu_count() or 1
    if hasattr(os, 'sched_getaffinity'):
        cpus = min(cpus, len(os.sched_getaffinity(0)))
    quota = Path('/sys/fs/cgroup/cpu.max')
    if quota.exists():
        limit, period = quota.read_text().split()
        if limit != 'max':
            cpus = min(cpus, max(1, int(limit) // int(period)))
    memory = next(int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines()
                  if line.startswith('MemTotal:'))
    limit = Path('/sys/fs/cgroup/memory.max')
    if limit.exists() and limit.read_text().strip() != 'max':
        memory = min(memory, int(limit.read_text()))
    return cpus, memory


def run_phase(name, command, environment, reported_command):
    phase = {'name': name, 'started_at': time.time(), 'command': reported_command,
             'workers': int(environment['VITEST_MAX_WORKERS'])}
    started = time.monotonic()
    if name == 'unit':
        command, selected = unit_selection.prepare(ROOT, command, environment, REPORTS)
        phase['selection'] = selected
        phase['command'] = [part.replace(str(ROOT), '<source>') for part in command]
        if selected['mode'] == 'documentation':
            return {**phase, 'seconds': time.monotonic() - started, 'exit_code': 0, 'skipped': True}
    print('\n>>> ' + name + ' (' + str(phase['workers']) + ' test workers)', flush=True)
    with (REPORTS / (name + '.log')).open('w') as log:
        process = subprocess.Popen(command, cwd=ROOT, env=environment,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            for line in process.stdout:
                sys.stdout.write('[' + name + '] ' + line)
                log.write(line)
            code = process.wait()
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait()
    phase.update(seconds=time.monotonic() - started, exit_code=code)
    return phase


def run_check():
    if os.environ.get('CI') != 'true':
        raise ValueError('ci:check runs in the disposable CI guest (CI=true); use ci-platform run')
    workers = worker_count(os.environ.get('VITEST_MAX_WORKERS', '4'))
    cpus, memory = available_resources()
    schedule = test_schedule(workers, cpus, memory)
    environment = {**os.environ, 'VITEST_MAX_WORKERS': str(schedule['workers_per_suite'])}
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if revision != os.environ.get('GITHUB_SHA'):
        raise ValueError('CI source revision does not match GITHUB_SHA')
    REPORTS.mkdir(exist_ok=True)
    # Never let a retry or failed phase reuse test evidence from another execution.
    for filename in ('unit-results.json', 'server-results.json'):
        (REPORTS / filename).unlink(missing_ok=True)
    commands = [(name, [part.replace(str(ROOT), '<source>') for part in command])
                for name, command in phases()]
    report = {'schema': SCHEMA, 'revision': revision, 'workers': workers,
              'visible_cpus': cpus, 'available_memory_bytes': memory, 'test_schedule': schedule,
              'started_at': time.time(),
              'condition': os.environ.get('CI_PLATFORM_BENCHMARK_CONDITION', 'unspecified'),
              'run_id': os.environ.get('GITHUB_RUN_ID'),
              'gates_sha256': hashlib.sha256(json.dumps(commands).encode()).hexdigest(),
              'phases': [], 'tests': {}, 'exit_code': None}
    started = time.monotonic()
    exit_code = 1
    try:
        gates = phases()
        index = 0
        while index < len(gates):
            group = gates[index:index + 2] if schedule['parallel'] and gates[index][0] == 'unit' else gates[index:index + 1]
            # Keep both complete reports when either suite fails. Neither pool exceeds half the job's worker budget.
            with ThreadPoolExecutor(max_workers=len(group)) as pool:
                futures = [pool.submit(run_phase, name, command, environment, commands[index + offset][1])
                           for offset, (name, command) in enumerate(group)]
                completed = [future.result() for future in futures]
            for phase in completed:
                report['phases'].append(phase)
                name = phase['name']
                if name in ('unit', 'server') and (REPORTS / (name + '-results.json')).exists():
                    report['tests'][name] = test_evidence(REPORTS / (name + '-results.json'))
            exit_code = next((phase['exit_code'] for phase in completed if phase['exit_code']), 0)
            save(report)
            if exit_code:
                break
            index += len(group)
        return exit_code
    except BaseException:
        exit_code = exit_code or 1
        raise
    finally:
        report.update(seconds=time.monotonic() - started, finished_at=time.time(), exit_code=exit_code)
        save(report)


def compare(baseline, candidate, condition):
    for report in (baseline, candidate):
        if report.get('schema') != SCHEMA or report.get('exit_code') != 0:
            raise ValueError('Both reports must be completed, passing ci:check runs')
        if report.get('condition') not in ('unspecified', condition):
            raise ValueError('Report condition does not match the selected comparison condition')
        if [phase['name'] for phase in report['phases']] != [name for name, _ in phases()]:
            raise ValueError('A report is missing a required gate')
        if any(phase.get('exit_code') != 0 for phase in report['phases']):
            raise ValueError('A required gate failed')
        if any(phase.get('selection', {}).get('mode', 'full') != 'full' for phase in report['phases']):
            raise ValueError('A scoped unit run cannot establish a full-suite speed comparison')
    if baseline['workers'] != 4 or candidate['workers'] != 8:
        raise ValueError('Compare four-worker baseline with eight-worker candidate')
    for key in ('revision', 'gates_sha256'):
        if baseline[key] != candidate[key]:
            raise ValueError('Reports differ in ' + key)
    for suite in ('unit', 'server'):
        for key in ('total', 'passed', 'failed', 'pending', 'identity_sha256'):
            if baseline['tests'][suite][key] != candidate['tests'][suite][key]:
                raise ValueError('Test coverage/outcome differs: ' + suite + '.' + key)
    return {'schema': SCHEMA, 'condition': condition, 'revision': baseline['revision'],
            'baseline_run_id': baseline.get('run_id'), 'candidate_run_id': candidate.get('run_id'),
            'baseline_seconds': baseline['seconds'], 'candidate_seconds': candidate['seconds'],
            'improvement_percent': 100 * (baseline['seconds'] - candidate['seconds']) / baseline['seconds'],
            'phases': [{'name': old['name'], 'baseline_seconds': old['seconds'],
                        'candidate_seconds': new['seconds']}
                       for old, new in zip(baseline['phases'], candidate['phases'])],
            'scope': 'Guest check execution only; pair with controller queue, preparation and teardown evidence.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('run')
    comparison = sub.add_parser('compare')
    comparison.add_argument('--baseline', required=True, type=Path)
    comparison.add_argument('--candidate', required=True, type=Path)
    comparison.add_argument('--condition', required=True, choices=('warm', 'cold', 'overlap'))
    args = parser.parse_args()
    if args.command == 'run':
        return run_check()
    print(json.dumps(compare(json.loads(args.baseline.read_text()),
                             json.loads(args.candidate.read_text()), args.condition), indent=2))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, KeyError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
