/**
 * The agent's staging approval (#12) as the desktop mock shows it once the run is done (`done` in `renderVals()`):
 * checks 41 of 41 and the review approved at 11:38, still waiting for a person, so the modal says "Approve and
 * deploy". The fixture serves the 11:22 state; the visual spec patches the cached `approvals.get` data to this one.
 */
export function patchApprovalReadyScript(burrow = 'burrow-hq', number = 12): string {
  return `(() => {
    const app = window.__WHOMBAT__;
    if (!app) throw new Error('window.__WHOMBAT__ is only set in dev builds');
    const qc = app.services.queryClient;
    const key = ['whombat', 'approvals.get', { burrow: ${JSON.stringify(burrow)}, number: ${number} }, {}];
    const d = qc.getQueryData(key);
    if (!d) throw new Error('approval not loaded');
    const conditions = d.approval.conditions.map((c) =>
      c.kind === 'checks_pass'
        ? { ...c, met: true, state: 'passed', passed: 41, total: 41, fixing: false, headSha: '7be20f7' }
        : c.kind === 'review_approved'
          ? { ...c, met: true, reviewState: 'approved', reviewedAt: '2026-09-23T09:38:00.000Z' }
          : c,
    );
    qc.setQueryData(key, { ...d, approval: { ...d.approval, conditions } });
  })()`;
}
