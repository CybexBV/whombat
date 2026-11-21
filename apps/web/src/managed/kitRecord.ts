/**
 * How this browser saw the recovery kit saved (app backup-options.md AP-6806): printed or downloaded, for which kit
 * generation. Control keeps the passkey's envelope; a print or a file only this browser can know about, so it is kept
 * here, per Whombat, as a convenience: lost storage only means Backups asks to save the kit once more.
 */
export interface KitSaved {
  generation: number;
  printedAt?: string;
  fileAt?: string;
}

const key = (device: string) => `whombat.kitSaved.${device}`;

export function readKitSaved(device: string): KitSaved | null {
  try {
    const raw = window.localStorage.getItem(key(device));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<KitSaved>;
    return typeof v.generation === 'number'
      ? {
          generation: v.generation,
          ...(typeof v.printedAt === 'string' ? { printedAt: v.printedAt } : {}),
          ...(typeof v.fileAt === 'string' ? { fileAt: v.fileAt } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

/** Notes a print or a download of the kit of `generation` (a newer generation forgets the older one's ways). */
export function noteKitSaved(
  device: string,
  generation: number,
  how: 'print' | 'file',
  at = new Date(),
): void {
  try {
    const was = readKitSaved(device);
    const base: KitSaved = was && was.generation === generation ? was : { generation };
    const next = { ...base, [how === 'print' ? 'printedAt' : 'fileAt']: at.toISOString() };
    window.localStorage.setItem(key(device), JSON.stringify(next));
  } catch {
    // Storage off: Backups asks again, nothing else changes.
  }
}
