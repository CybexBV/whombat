import { relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/**
 * Starts the files that took longest last time first, whatever their project. Vitest's own order runs the projects one
 * after another by name, so the web app's slow files started last and every run waited on them at its end. Files with
 * no time yet go first, largest first as Vitest does; then the ones that failed last time; then the slowest.
 */
export class LongestFirst extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { cache, config } = this.ctx;
    const key = (spec: TestSpecification) => `${spec.project.name}:${relative(config.root, spec.moduleId)}`;
    const last = new Map(files.map((spec) => [spec, cache.getFileTestResults(key(spec))]));
    const size = (spec: TestSpecification) => cache.getFileStats(key(spec))?.size ?? 0;
    return [...files].sort((a, b) => {
      const group = a.project.config.sequence.groupOrder - b.project.config.sequence.groupOrder;
      if (group !== 0) return group;
      const ra = last.get(a);
      const rb = last.get(b);
      if (!ra || !rb) return ra ? 1 : rb ? -1 : size(b) - size(a);
      if (ra.failed !== rb.failed) return ra.failed ? -1 : 1;
      return rb.duration - ra.duration;
    });
  }
}
