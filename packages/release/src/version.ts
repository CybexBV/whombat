/**
 * Component version order (CT-135): the rule the appliance's helper and manager use to refuse a release older than the
 * installed one (`CheckForward`, MA-21c), and control's `notOlder`. Go `release.CompareVersions` is the same code;
 * `compat.json` → `versions` pins both.
 */

const MAX_U64 = 18_446_744_073_709_551_615n;

/** A dotted segment Go's `strconv.ParseUint(s, 10, 64)` accepts: ASCII digits only, within 64 bits. */
function numeric(s: string): bigint | null {
  if (!/^[0-9]+$/.test(s)) return null;
  const n = BigInt(s);
  return n <= MAX_U64 ? n : null;
}

/** Byte order of the UTF-8 encodings (Go `strings.Compare`), which is code point order. */
function compareText(a: string, b: string): -1 | 0 | 1 {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = (x[i] as string).codePointAt(0) as number;
    const q = (y[i] as string).codePointAt(0) as number;
    if (p !== q) return p < q ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

function compareDotted(a: string, b: string): -1 | 0 | 1 {
  const as = a.split('.');
  const bs = b.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i] ?? '0';
    const y = bs[i] ?? '0';
    const xn = numeric(x);
    const yn = numeric(y);
    if (xn !== null && yn !== null) {
      if (xn !== yn) return xn < yn ? -1 : 1;
    } else if (xn !== null) {
      return -1; // numeric sorts before alphanumeric (semver)
    } else if (yn !== null) {
      return 1;
    } else {
      const c = compareText(x, y);
      if (c !== 0) return c;
    }
  }
  return 0;
}

const cut = (s: string, sep: string): [string, string, boolean] => {
  const i = s.indexOf(sep);
  return i < 0 ? [s, '', false] : [s.slice(0, i), s.slice(i + sep.length), true];
};

/**
 * One release id family (4.4; Whombat whombat-link.md): `whombat-YYYYMMDD.N` and `whombat-dev-YYYYMMDD.N` order by
 * date and build number alone, the `dev-` ignored, so a box moves between the Production and Development channels
 * without going back.
 */
const RELEASE_ID_RE = /^whombat-(dev-)?([0-9]{8})[.]([0-9]{1,18})$/;

function releaseIdOrder(id: string): { date: string; n: bigint } | null {
  const m = RELEASE_ID_RE.exec(id);
  return m ? { date: m[2] as string, n: BigInt(m[3] as string) } : null;
}

/**
 * Orders two component versions: −1 when `a` is older, 0 when equal, 1 when newer. Build metadata (after the first
 * `+`) is ignored; the core and the pre-release split at the first `-`; each is compared by dotted segments, a missing
 * segment counting as `0`: two numeric segments numerically, a numeric one before an alphanumeric one, otherwise by
 * text (bytes); a pre-release sorts before the release of the same core.
 *
 * The forms in use: runtime `<Whombat semver>-<commit time UTC YYYYMMDDHHMMSS>.<shortrev>[.p<digest>][.<label>]`,
 * manager `<appliance semver>-<commit time>.<shortrev>` (dev builds `0.2.0-dev`), host = the release id
 * (`whombat-YYYYMMDD.N`, `whombat-dev-YYYYMMDD.N`; before them `pve-YYYYMMDD.N`, `pve-dev-YYYYMMDD.N`, which compare
 * older: `pve` sorts before `whombat`, CT-550). Two release ids of the one family (`whombat-YYYYMMDD.N`,
 * `whombat-dev-YYYYMMDD.N`) compare by date, then build number, whatever their prefix (4.4): equal date and number is
 * 0. Every `0.1.0-<hex>` version before them is older than any `0.2.0-…`
 * (UP-A1, UP-A2): their pre-releases are compared as text, so they were never ordered by build.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const ra = releaseIdOrder(a);
  const rb = releaseIdOrder(b);
  if (ra && rb) {
    if (ra.date !== rb.date) return ra.date < rb.date ? -1 : 1;
    if (ra.n !== rb.n) return ra.n < rb.n ? -1 : 1;
    return 0;
  }
  const [ac, apre, aHasPre] = cut(cut(a, '+')[0], '-');
  const [bc, bpre, bHasPre] = cut(cut(b, '+')[0], '-');
  const c = compareDotted(ac, bc);
  if (c !== 0) return c;
  if (aHasPre && !bHasPre) return -1;
  if (!aHasPre && bHasPre) return 1;
  return compareDotted(apre, bpre);
}
