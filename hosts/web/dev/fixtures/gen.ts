// Deterministic sample-series generator, ported from the mockup's design source
// (docs/handoff/design/source/Main.dc.html, Server.dc.html, Proxmox.dc.html).
// Used only by the fixture dev server so sparklines, the heatmap and the detail
// charts look like the reference screenshots. Not shipped in the UI bundle.

export interface GenOptions {
  base: number;
  amp?: number;
  noise?: number;
  saw?: number;
  spikes?: number;
  spikeH?: number;
  now: number;
  min: number;
  max: number;
}

/** FNV-1a 32-bit hash of a string (same as the mockup). */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Linear congruential generator returning floats in [0, 1). */
export function rnd(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * n samples, `step` minutes apart, ending "now" (14:00 in the mockup's clock).
 * Daily sine + AR(1) noise + optional saw-tooth and spikes, blended so the last
 * sample equals `o.now`.
 */
export function gen(key: string, n: number, step: number, o: GenOptions): number[] {
  const r = rnd(hash(key));
  const out: number[] = [];
  let ar = 0;
  const sp: { i: number; h: number; w: number }[] = [];
  const per = Math.max(8, Math.round(n / 3));
  for (let k = 0; k < (o.spikes ?? 0); k++) {
    sp.push({ i: Math.floor(r() * n), h: (0.5 + r() * 0.5) * (o.spikeH ?? 0), w: 1 + Math.floor(r() * 3) });
  }
  for (let i = 0; i < n; i++) {
    const ago = (n - 1 - i) * step;
    const tod = (((840 - ago) % 1440) + 1440) % 1440;
    ar = ar * 0.7 + (r() - 0.5) * 0.6;
    let v = o.base + (o.amp ?? 0) * Math.sin((tod / 1440) * 6.2832 - 2.2) + (o.noise ?? 0) * ar * 3;
    if (o.saw) v += o.saw * ((i % per) / per - 0.5);
    for (const s of sp) {
      const d = Math.abs(i - s.i);
      if (d <= s.w) v += s.h * (1 - d / (s.w + 1));
    }
    out.push(v);
  }
  const last = out[n - 1] ?? o.now;
  const delta = o.now - last;
  for (let i = 0; i < n; i++) {
    let w = (i / (n - 1) - 0.86) / 0.14;
    w = Math.max(0, Math.min(1, w));
    w = w * w * (3 - 2 * w);
    out[i] = Math.max(o.min, Math.min(o.max, (out[i] ?? 0) + delta * w));
  }
  out[n - 1] = o.now;
  return out;
}

export const round1 = (v: number): number => Math.round(v * 10) / 10;
