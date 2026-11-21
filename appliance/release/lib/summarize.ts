/**
 * release/lib/summarize.ts — merges the SBOMs and scan results of one `release/sbom` run into
 * licenses.{json,md}, vulnerabilities.{json,md} and provenance.json (docs/release/sbom.md).
 * Node 24 (type stripping), no dependencies: it must run from a clean checkout without an install.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    pins: { type: 'string' },
    'pins-from': { type: 'string' },
    work: { type: 'string' },
    out: { type: 'string' },
    scratch: { type: 'string' },
    policy: { type: 'string' },
    triage: { type: 'string' },
    'run-id': { type: 'string' },
  },
});
const need = (k: keyof typeof args): string => {
  const v = args[k];
  if (typeof v !== 'string') throw new Error(`--${k} is required`);
  return v;
};
const pinsFile = need('pins');
const work = need('work');
const out = need('out');
const scratch = need('scratch');
const readJson = <T = any>(f: string): T => JSON.parse(readFileSync(f, 'utf8')) as T;
const sha256 = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
const pins = readJson(pinsFile);
const policy = readJson(need('policy'));
const triage = existsSync(need('triage')) ? readJson(need('triage')) : { rules: [] };

// ---------------------------------------------------------------------------------------------------------------
// Licenses

type Category =
  | 'permissive'
  | 'weak-copyleft'
  | 'strong-copyleft'
  | 'network-copyleft'
  | 'non-osi'
  | 'proprietary'
  | 'unknown'
  | 'first-party'
  | 'not-applicable';
const RANK: Category[] = [
  'permissive',
  'weak-copyleft',
  'strong-copyleft',
  'network-copyleft',
  'non-osi',
  'proprietary',
  'unknown',
];
const FLAGGED: Category[] = [
  'weak-copyleft',
  'strong-copyleft',
  'network-copyleft',
  'non-osi',
  'proprietary',
  'unknown',
  'first-party',
];
const byLicense = new Map<string, Category>();
for (const [cat, ids] of Object.entries(policy.categories) as [Category, string[]][])
  for (const id of ids) byLicense.set(id.toLowerCase(), cat);
const alias = (s: string): string => policy.aliases[s] ?? policy.aliases[s.trim()] ?? s.trim();

function classifyId(id: string): Category {
  const a = alias(id.replace(/^\(|\)$/g, ''));
  return byLicense.get(a.toLowerCase()) ?? (/unfree/i.test(a) ? 'proprietary' : 'unknown');
}

/** Tiny SPDX expression evaluator: OR → best, AND → worst, WITH → the base license. */
function classifyExpr(expr: string): Category {
  const tokens = expr.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const worst = (a: Category, b: Category) => (RANK.indexOf(a) >= RANK.indexOf(b) ? a : b);
  const best = (a: Category, b: Category) => (RANK.indexOf(a) <= RANK.indexOf(b) ? a : b);
  function primary(): Category {
    const t = tokens[i++];
    if (t === '(') {
      const v = or();
      i++; // ')'
      return v;
    }
    let id = t ?? '';
    // Multi-word names (Gradle POMs) are not SPDX expressions: classify the whole string.
    if (tokens[i] === 'WITH') i += 2;
    return classifyId(id);
  }
  function and(): Category {
    let v = primary();
    while (tokens[i] === 'AND') {
      i++;
      v = worst(v, primary());
    }
    return v;
  }
  function or(): Category {
    let v = and();
    while (tokens[i] === 'OR') {
      i++;
      v = best(v, and());
    }
    return v;
  }
  if (!/\b(AND|OR|WITH)\b/.test(expr)) return classifyId(expr);
  return or();
}

interface Comp {
  sbom: string;
  name: string;
  group?: string;
  version: string;
  purl?: string;
  licenses: string[];
  category: Category;
  scope: 'shipped' | 'dev';
  note?: string;
}

function licenseStrings(c: any): string[] {
  const entries = [...(c.licenses ?? []), ...(c.evidence?.licenses ?? [])];
  const outL: string[] = [];
  for (const e of entries) {
    const s = e.expression ?? e.license?.id ?? e.license?.name;
    if (s && !outL.includes(s)) outL.push(s);
  }
  return outL;
}

function annotate(c: any, sbom: string): { category?: Category; license?: string; note?: string } | undefined {
  const props = new Map<string, string>((c.properties ?? []).map((p: any) => [p.name, p.value]));
  for (const a of policy.annotations) {
    const m = a.match;
    if (m.group && c.group !== m.group) continue;
    const full = c.group ? `${c.group}/${c.name}` : c.name;
    if (m.name && c.name !== m.name && full !== m.name) continue;
    if (m.nameIn && !m.nameIn.includes(c.name)) continue;
    if (m.sbom && sbom !== m.sbom) continue;
    if (m.namePrefix && !String(c.name).startsWith(m.namePrefix)) continue;
    if (m.nameMatch && !new RegExp(m.nameMatch).test(String(c.name))) continue;
    if (m.sbomPrefix && !sbom.startsWith(m.sbomPrefix)) continue;
    if (m.noPosition && props.has('nix:position')) continue;
    return a;
  }
  return undefined;
}

const sbomDir = join(out, 'sbom');
const sbomFiles = existsSync(sbomDir) ? readdirSync(sbomDir).filter((f) => f.endsWith('.cdx.json')).sort() : [];
const comps: Comp[] = [];
const sbomMeta: any[] = [];
for (const f of sbomFiles) {
  const sbom = basename(f, '.cdx.json');
  const d = readJson(join(sbomDir, f));
  const tool = d.metadata?.tools?.components?.[0] ?? d.metadata?.tools?.[0] ?? {};
  // An SBOM of a single package (sbomnix on a provider CLI) has only its subject: inventory the subject.
  const list: any[] = d.components?.length ? d.components : d.metadata?.component ? [d.metadata.component] : [];
  sbomMeta.push({
    file: `sbom/${f}`,
    sha256: sha256(join(sbomDir, f)),
    specVersion: d.specVersion,
    generator: `${tool.name ?? '?'} ${tool.version ?? ''}`.trim(),
    subject: d.metadata?.component?.name ?? null,
    subjectVersion: d.metadata?.component?.version ?? null,
    components: list.length,
  });
  const spdx = join(sbomDir, `${sbom}.spdx.json`);
  if (existsSync(spdx)) sbomMeta.at(-1).spdx = { file: `sbom/${sbom}.spdx.json`, sha256: sha256(spdx) };
  for (const c of list) {
    const ann = annotate(c, sbom);
    let lic = licenseStrings(c);
    if (ann?.license && lic.length === 0) lic = [ann.license];
    let category: Category;
    if (ann?.category) category = ann.category;
    else if (lic.length === 0) category = 'unknown';
    else
      category = lic
        .map(classifyExpr)
        .reduce((a, b) => (RANK.indexOf(a) >= RANK.indexOf(b) ? a : b)); // several entries: all apply
    comps.push({
      sbom,
      name: c.name,
      group: c.group,
      version: c.version ?? '',
      purl: c.purl,
      licenses: lic,
      category,
      scope: c.scope === 'excluded' ? 'dev' : 'shipped',
      note: ann?.note,
    });
  }
}

// Android modules compiled as local Gradle subprojects take their npm package's license (policy.crossRefs).
const xr = policy.crossRefs;
if (xr) {
  for (const c of comps) {
    if (c.sbom !== xr.sbom || c.licenses.length) continue;
    const npm = xr.map[c.group ? `${c.group}/${c.name}` : c.name];
    if (!npm) continue;
    const src = comps.find((x) => x.sbom === xr.fromSbom && (x.group ? `${x.group}/${x.name}` : x.name) === npm);
    if (!src) continue;
    c.licenses = src.licenses;
    c.category = src.category;
    c.note = `local Gradle module compiled from npm ${npm}@${src.version}; license taken from ${xr.fromSbom}`;
  }
}

const catOrder: Category[] = [...RANK, 'first-party', 'not-applicable'];
const perSbom = sbomMeta.map((m) => {
  const sb = basename(m.file, '.cdx.json');
  const mine = comps.filter((c) => c.sbom === sb);
  const counts: Record<string, number> = {};
  for (const c of mine) counts[`${c.category}${c.scope === 'dev' ? ' (dev)' : ''}`] = (counts[`${c.category}${c.scope === 'dev' ? ' (dev)' : ''}`] ?? 0) + 1;
  return { sbom: sb, total: mine.length, shipped: mine.filter((c) => c.scope === 'shipped').length, counts };
});
const flagged = comps.filter((c) => FLAGGED.includes(c.category) && c.scope === 'shipped');
// Deduplicate flagged rows across SBOMs by name@version + category.
const flaggedMap = new Map<string, Comp & { sboms: string[] }>();
for (const c of flagged) {
  const k = `${c.group ? `${c.group}/` : ''}${c.name}@${c.version}|${c.category}`;
  const cur = flaggedMap.get(k);
  if (cur) {
    if (!cur.sboms.includes(c.sbom)) cur.sboms.push(c.sbom);
  } else flaggedMap.set(k, { ...c, sboms: [c.sbom] });
}
const flaggedRows = [...flaggedMap.values()].sort(
  (a, b) => catOrder.indexOf(a.category) - catOrder.indexOf(b.category) || a.name.localeCompare(b.name),
);
writeFileSync(
  join(out, 'licenses.json'),
  `${JSON.stringify(
    {
      $schema: 'whombat.release-licenses/1',
      productVersion: pins.productVersion,
      policy: 'release/policy/licenses.json',
      perSbom,
      flagged: flaggedRows.map(({ sboms, name, group, version, licenses, category, note, purl }) => ({
        name: group ? `${group}/${name}` : name,
        version,
        purl,
        licenses,
        category,
        note,
        sboms,
      })),
      components: comps,
    },
    null,
    1,
  )}\n`,
);

const esc = (s: string) => s.replace(/\|/g, '\\|');
let md = `# License inventory — ${pins.productVersion}\n\n`;
md += `Generated by \`release/sbom\` (run ${args['run-id']}) from the SBOMs in \`sbom/\`; classification policy \`release/policy/licenses.json\`.\n`;
md += `**Engineering inventory, not legal advice. Every flagged row requires qualified review before commercial distribution.**\n\n`;
md += `“shipped” = runtime/production scope (pnpm non-dev, Go linked modules, Android releaseRuntimeClasspath, Nix runtime closure); “dev” = build/test only (pnpm scope \`excluded\`).\n\n`;
md += `## Per SBOM\n\n| SBOM | components | shipped | ${catOrder.join(' | ')} |\n|---|---|---|${catOrder.map(() => '---').join('|')}|\n`;
for (const p of perSbom)
  md += `| ${p.sbom} | ${p.total} | ${p.shipped} | ${catOrder
    .map((c) => {
      const s = p.counts[c] ?? 0;
      const d = p.counts[`${c} (dev)`] ?? 0;
      return d ? `${s} (+${d} dev)` : `${s}`;
    })
    .join(' | ')} |\n`;
md += `\n## Flagged shipped components (${flaggedRows.length})\n\n`;
for (const cat of catOrder.filter((c) => FLAGGED.includes(c))) {
  const rows = flaggedRows.filter((r) => r.category === cat);
  if (!rows.length) continue;
  md += `### ${cat} (${rows.length})\n\n| component | version | licenses | where | note |\n|---|---|---|---|---|\n`;
  for (const r of rows)
    md += `| ${esc(r.group ? `${r.group}/${r.name}` : r.name)} | ${esc(r.version)} | ${esc(r.licenses.join('; ') || '—')} | ${r.sboms.join(', ')} | ${esc(r.note ?? '')} |\n`;
  md += '\n';
}
writeFileSync(join(out, 'licenses.md'), md);

// ---------------------------------------------------------------------------------------------------------------
// Vulnerabilities

interface Finding {
  sbom: string;
  id: string;
  aliases: string[];
  package: string;
  version: string;
  severity: string;
  cvss?: number | null;
  fixedIn: string[];
  scope: 'shipped' | 'dev';
  scanners: string[];
  reachable?: boolean | null;
  triage?: { status: string; justification: string; owner?: string };
}
const findings: Finding[] = [];
const scanDir = join(work, 'scan');
const scopeOf = (sbom: string, name: string, version: string): 'shipped' | 'dev' => {
  const hits = comps.filter(
    (c) => c.sbom === sbom && (c.name === name || `${c.group}/${c.name}` === name) && c.version === version,
  );
  return hits.length && hits.every((c) => c.scope === 'dev') ? 'dev' : 'shipped';
};
/** Package identity across scanners: grype says `gson`, OSV `com.google.code.gson:gson`. */
const pkgKey = (p: string) => p.toLowerCase().split(/[:/]/).at(-1) ?? p;
const severityOf = (s: string, score?: number | null): { severity: string; cvss: number | null } => {
  const n = score ?? (/^\d+(\.\d+)?$/.test(s) ? Number(s) : null);
  if (n !== null && !/^[A-Za-z]/.test(s))
    return { severity: n >= 9 ? 'Critical' : n >= 7 ? 'High' : n >= 4 ? 'Medium' : n > 0 ? 'Low' : 'Unknown', cvss: n };
  const t = s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : 'Unknown';
  return { severity: t === 'Moderate' ? 'Medium' : t, cvss: n };
};
function add(f: Omit<Finding, 'scanners' | 'aliases'> & { scanner: string; aliases?: string[] }) {
  const ids = new Set([f.id, ...(f.aliases ?? [])]);
  Object.assign(f, severityOf(f.severity, f.cvss));
  const cur = findings.find(
    (x) =>
      x.sbom === f.sbom &&
      pkgKey(x.package) === pkgKey(f.package) &&
      x.version === f.version &&
      (ids.has(x.id) || x.aliases.some((a) => ids.has(a))),
  );
  if (cur) {
    if (!cur.scanners.includes(f.scanner)) cur.scanners.push(f.scanner);
    for (const a of ids) if (a !== cur.id && !cur.aliases.includes(a)) cur.aliases.push(a);
    if (cur.severity === 'Unknown' && f.severity !== 'Unknown') cur.severity = f.severity;
    if (!cur.cvss && f.cvss) cur.cvss = f.cvss;
    if (!cur.fixedIn.length && f.fixedIn.length) cur.fixedIn = f.fixedIn;
    if (f.reachable !== undefined && cur.reachable === undefined) cur.reachable = f.reachable;
    return;
  }
  const { scanner, aliases, ...rest } = f;
  findings.push({ ...rest, aliases: [...ids].filter((a) => a !== f.id), scanners: [scanner] });
}
const scanFiles = existsSync(scanDir) ? readdirSync(scanDir).sort() : [];
for (const f of scanFiles) {
  const p = join(scanDir, f);
  if (f.endsWith('.grype.json')) {
    const sbom = f.replace(/\.grype\.json$/, '');
    for (const m of readJson(p).matches ?? []) {
      const v = m.vulnerability;
      add({
        sbom,
        id: v.id,
        aliases: (m.relatedVulnerabilities ?? []).map((r: any) => r.id),
        package: m.artifact.name,
        version: m.artifact.version,
        severity: v.severity ?? 'Unknown',
        cvss: v.cvss?.[0]?.metrics?.baseScore ?? null,
        fixedIn: v.fix?.versions ?? [],
        scope: scopeOf(sbom, m.artifact.name, m.artifact.version),
        scanner: 'grype',
      });
    }
  } else if (f.endsWith('.osv.json')) {
    const sbom = f.replace(/\.osv\.json$/, '');
    let d: any;
    try {
      d = readJson(p);
    } catch {
      continue;
    }
    for (const r of d.results ?? [])
      for (const pk of r.packages ?? [])
        for (const v of pk.vulnerabilities ?? []) {
          const sev =
            (pk.groups ?? []).find((g: any) => g.ids?.includes(v.id))?.max_severity ??
            v.database_specific?.severity ??
            'Unknown';
          const fixed: string[] = [];
          for (const a of v.affected ?? [])
            for (const r2 of a.ranges ?? []) for (const e of r2.events ?? []) if (e.fixed) fixed.push(e.fixed);
          add({
            sbom,
            id: v.id,
            aliases: v.aliases ?? [],
            package: pk.package.name,
            version: pk.package.version,
            severity: String(sev),
            fixedIn: [...new Set(fixed)],
            scope: scopeOf(sbom, pk.package.name, pk.package.version),
            scanner: 'osv-scanner',
          });
        }
  } else if (f.endsWith('.govulncheck.json')) {
    const sbom = f.replace(/\.govulncheck\.json$/, '');
    const text = readFileSync(p, 'utf8');
    const osv = new Map<string, any>();
    const found: any[] = [];
    // govulncheck -format json is a stream of concatenated JSON objects.
    let depth = 0;
    let start = -1;
    let inStr = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') {
        if (depth++ === 0) start = i;
      } else if (ch === '}' && --depth === 0) {
        const o = JSON.parse(text.slice(start, i + 1));
        if (o.osv) osv.set(o.osv.id, o.osv);
        if (o.finding) found.push(o.finding);
      }
    }
    const seen = new Set<string>();
    for (const fd of found) {
      const key = `${fd.osv}|${fd.trace?.[0]?.module}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const reachable = found.some((x) => x.osv === fd.osv && x.trace?.[0]?.function);
      const o = osv.get(fd.osv);
      add({
        sbom,
        id: fd.osv,
        aliases: o?.aliases ?? [],
        package: fd.trace?.[0]?.module ?? '?',
        version: fd.trace?.[0]?.version ?? '?',
        severity: 'Unknown',
        fixedIn: fd.fixed_version ? [fd.fixed_version] : [],
        scope: 'shipped',
        reachable,
        scanner: 'govulncheck',
      });
    }
  } else if (f.endsWith('.vulns.csv')) {
    const sbom = f.replace(/\.vulns\.csv$/, '');
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    const head = lines[0].split(',').map((h) => h.replace(/"/g, ''));
    for (const line of lines.slice(1)) {
      const cells = [...line.matchAll(/"((?:[^"]|"")*)"|([^,]+)|(?<=,)(?=,|$)/g)].map((m) => m[1] ?? m[2] ?? '');
      const row = Object.fromEntries(head.map((h, i) => [h, cells[i] ?? '']));
      const score = row.severity ? Number(row.severity) : null;
      const scanners = ['grype', 'osv', 'vulnix'].filter((s) => row[s] === '1').map((s) => `vulnxscan/${s}`);
      const sev =
        score === null || Number.isNaN(score)
          ? 'Unknown'
          : score >= 9
            ? 'Critical'
            : score >= 7
              ? 'High'
              : score >= 4
                ? 'Medium'
                : 'Low';
      findings.push({
        sbom,
        id: row.vuln_id,
        aliases: [],
        package: row.package,
        version: row.version_local,
        severity: sev,
        cvss: score,
        fixedIn: [],
        scope: 'shipped',
        scanners,
      });
    }
  }
}

function matchRule(rule: any, x: Finding): boolean {
  const m = rule.match ?? {};
  const ids = [x.id, ...x.aliases];
  if (m.id && !(Array.isArray(m.id) ? m.id : [m.id]).some((i: string) => ids.includes(i))) return false;
  if (m.package && !(Array.isArray(m.package) ? m.package : [m.package]).some((p: string) => pkgKey(p) === pkgKey(x.package)))
    return false;
  if (m.version && !(Array.isArray(m.version) ? m.version : [m.version]).includes(x.version)) return false;
  if (m.reachable !== undefined && x.reachable !== m.reachable) return false;
  if (m.sbomPrefix && !x.sbom.startsWith(m.sbomPrefix)) return false;
  if (m.sbom && !(Array.isArray(m.sbom) ? m.sbom : [m.sbom]).includes(x.sbom)) return false;
  if (m.scope && x.scope !== m.scope) return false;
  if (m.onlyScanner && !(x.scanners.length === 1 && x.scanners[0] === m.onlyScanner)) return false;
  return true;
}
for (const x of findings) {
  const rule = (triage.rules ?? []).find((r: any) => matchRule(r, x));
  x.triage = rule
    ? { status: rule.status, justification: rule.justification, owner: rule.owner }
    : { status: 'untriaged', justification: '' };
}
const sevRank = ['Critical', 'High', 'Medium', 'Low', 'Negligible', 'Unknown'];
findings.sort(
  (a, b) =>
    sevRank.indexOf(a.severity) - sevRank.indexOf(b.severity) ||
    a.sbom.localeCompare(b.sbom) ||
    a.package.localeCompare(b.package) ||
    a.id.localeCompare(b.id),
);
const databases: any = {};
if (existsSync(join(scanDir, 'grype-db.json'))) databases.grype = readJson(join(scanDir, 'grype-db.json'));
for (const f of scanFiles.filter((x) => x.endsWith('.govulncheck.json')).slice(0, 1)) {
  const m = /"db_last_modified":\s*"([^"]+)"/.exec(readFileSync(join(scanDir, f), 'utf8'));
  const v = /"scanner_version":\s*"([^"]+)"/.exec(readFileSync(join(scanDir, f), 'utf8'));
  databases.govulncheck = { db: 'https://vuln.go.dev', lastModified: m?.[1], scanner: v?.[1] };
}
databases.osvScanner = 'osv.dev API at scan time (see generatedAt)';
databases.vulnix = 'NVD feeds fetched by vulnix at scan time (see generatedAt)';
writeFileSync(
  join(out, 'vulnerabilities.json'),
  `${JSON.stringify(
    {
      $schema: 'whombat.release-vulnerabilities/1',
      productVersion: pins.productVersion,
      generatedAt: new Date().toISOString(),
      databases,
      triagePolicy: 'release/policy/triage.json',
      findings,
    },
    null,
    1,
  )}\n`,
);
const count = (pred: (x: Finding) => boolean) => findings.filter(pred).length;
let vm = `# Vulnerability scan — ${pins.productVersion}\n\n`;
vm += `Generated by \`release/sbom\` (run ${args['run-id']}, ${new Date().toISOString()}). Scanners: grype + osv-scanner on every non-Nix SBOM, govulncheck (symbol level) on every Go binary, vulnxscan (vulnix + grype + OSV) on the NixOS closure. Databases: grype ${databases.grype?.built ?? '?'} (schema ${databases.grype?.schemaVersion ?? '?'}), vuln.go.dev ${databases.govulncheck?.lastModified ?? '?'}, osv.dev and NVD live at scan time.\n\n`;
vm += `Triage decisions live in \`release/policy/triage.json\` (first matching rule wins); \`untriaged\` rows need a decision. Nothing here was fixed: this is a report.\n\n`;
vm += `| | findings | shipped | dev only | untriaged |\n|---|---|---|---|---|\n`;
for (const s of sevRank) {
  const n = count((x) => x.severity === s);
  if (!n) continue;
  vm += `| ${s} | ${n} | ${count((x) => x.severity === s && x.scope === 'shipped')} | ${count((x) => x.severity === s && x.scope === 'dev')} | ${count((x) => x.severity === s && x.triage?.status === 'untriaged')} |\n`;
}
vm += `\nBy triage status: ${Object.entries(
  findings.reduce<Record<string, number>>((a, x) => {
    const k = x.triage?.status ?? 'untriaged';
    a[k] = (a[k] ?? 0) + 1;
    return a;
  }, {}),
)
  .map(([k, v]) => `${k} ${v}`)
  .join(' · ')}\n\n`;
const groups = [...new Set(findings.map((x) => x.sbom))];
for (const g of groups) {
  const rows = findings.filter((x) => x.sbom === g);
  vm += `## ${g} (${rows.length})\n\n| id | package | version | severity | scope | fixed in | scanners | triage |\n|---|---|---|---|---|---|---|---|\n`;
  for (const x of rows)
    vm += `| ${x.id}${x.aliases.length ? ` (${x.aliases.slice(0, 2).join(', ')})` : ''} | ${esc(x.package)} | ${esc(x.version)} | ${x.severity}${x.cvss ? ` ${x.cvss}` : ''} | ${x.scope}${x.reachable === false ? ', not reachable' : x.reachable ? ', reachable' : ''} | ${esc(x.fixedIn.join(', ') || '—')} | ${x.scanners.join(', ')} | **${x.triage?.status}** ${esc(x.triage?.justification ?? '')} |\n`;
  vm += '\n';
}
const clean = sbomMeta.map((m) => basename(m.file, '.cdx.json')).filter((s) => !groups.includes(s));
const goClean = scanFiles
  .filter((f) => f.endsWith('.govulncheck.json'))
  .map((f) => f.replace(/\.govulncheck\.json$/, ''))
  .filter((s) => !groups.includes(s));
vm += `## No findings\n\nSBOMs: ${clean.join(', ') || '—'}.\n\nGo binaries (govulncheck): ${goClean.join(', ') || '—'}.\n`;
writeFileSync(join(out, 'vulnerabilities.md'), vm);

// ---------------------------------------------------------------------------------------------------------------
// Provenance

const report = existsSync(join(work, 'build-report.json')) ? readJson(join(work, 'build-report.json')) : null;
const steps = existsSync(join(work, 'steps.jsonl'))
  ? readFileSync(join(work, 'steps.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : [];
const tools = existsSync(join(work, 'tools.json')) ? readJson(join(work, 'tools.json')).tools : {};
const nix: any = {};
// The system closure, and the provider CLIs of a commit that still packaged them: what was built, nothing else.
for (const attr of ['appliance-toplevel', 'whombat-provider-codex', 'whombat-provider-claude']) {
  const text = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim() : '');
  const outPath = text(join(work, `${attr}.outpath`));
  const source = text(join(work, `${attr}.src.json`));
  if (!outPath && !source && attr !== 'appliance-toplevel') continue;
  nix[attr] = { outPath: outPath || null, source: source ? JSON.parse(source) : undefined };
}
const appliance = pins.components.find((c: any) => c.repository === 'whombat-appliance');
writeFileSync(
  join(out, 'provenance.json'),
  `${JSON.stringify(
    {
      $schema: 'whombat.release-provenance/1',
      productVersion: pins.productVersion,
      releaseId: pins.tuple?.releaseId,
      contracts: pins.contracts,
      runId: args['run-id'],
      generatedAt: new Date().toISOString(),
      pins: {
        file: args['pins-from'] ?? 'manifest/pins.json',
        sha256: sha256(pinsFile),
        updatedAt: pins.updatedAt,
      },
      builder: {
        command: 'manifest/build --keep --no-manifest (clean git clone --no-local at each pinned commit)',
        buildRunId: report?.runId,
        host: report?.host,
        scratch,
        startedAt: report?.startedAt,
        finishedAt: report?.finishedAt,
      },
      components: pins.components.map((c: any) => {
        const b = report?.components?.find((x: any) => x.id === c.id);
        return {
          id: c.id,
          repository: c.repository,
          remote: c.remote ?? null,
          ref: c.ref,
          tag: c.tag ?? null,
          commit: c.commit,
          version: c.version,
          cleanClone: b?.cleanClone ?? null,
          vendoredContracts: b?.contracts ?? null,
          build: c.build.map((s: any) => ({ run: s.run, cwd: s.cwd, env: s.env })),
          steps: b?.steps ?? null,
          artifacts: (b?.artifacts ?? []).map((a: any) => ({
            name: a.name,
            kind: a.kind,
            sha256: a.sha256,
            detail: a.detail,
            files: a.files,
          })),
          buildOk: b?.ok ?? null,
        };
      }),
      nix: {
        flake: `git+file://<${appliance?.dir ? 'whombat' : 'whombat-appliance'}>?rev=${appliance?.commit}${appliance?.dir ? `&dir=${appliance.dir}` : ''}`,
        nixpkgs: tools.nixpkgs,
        outputs: nix,
        note: 'appliance-toplevel is the NixOS system generation (class 2 update). The runtime Nix closure (tuple.runtime) is not built yet (pins placeholders); the runtime is inventoried from its pnpm workspace.',
      },
      placeholders: pins.placeholders,
      tools,
      sboms: sbomMeta,
      steps,
    },
    null,
    1,
  )}\n`,
);

process.stderr.write(
  `summarize: ${sbomMeta.length} SBOMs, ${comps.length} component rows, ${flaggedRows.length} flagged shipped, ${findings.length} findings (${count((x) => x.triage?.status === 'untriaged')} untriaged)\n`,
);
