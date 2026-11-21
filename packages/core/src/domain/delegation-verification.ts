/** Evidence a task returns for the exact revision and set of changes it checked. */
import { z } from 'zod';

const Revision = z.string().regex(/^[0-9a-f]{40}$/);
const CheckName = z.string().trim().min(1);

export const DelegationVerification = z
  .object({
    revision: Revision,
    base: Revision,
    inputs: z.string().regex(/^[0-9a-f]{64}$/),
    generation: z.number().int().nonnegative(),
    expected: z.array(CheckName).max(100),
    results: z
      .array(
        z.object({
          name: CheckName,
          revision: Revision,
          state: z.enum(['passing', 'failing', 'running', 'missing']),
        }),
      )
      .max(100),
    noChecks: z.boolean().optional(),
  })
  .superRefine((proof, ctx) => {
    if (new Set(proof.expected).size !== proof.expected.length)
      ctx.addIssue({ code: 'custom', path: ['expected'], message: 'Expected check names must be unique.' });
    if (proof.expected.length === 0 && (proof.noChecks !== true || proof.results.length !== 0))
      ctx.addIssue({
        code: 'custom',
        path: ['noChecks'],
        message: 'A repository without checks must say so and have no check results.',
      });
    if (proof.noChecks === true && proof.expected.length !== 0)
      ctx.addIssue({
        code: 'custom',
        path: ['expected'],
        message: 'A repository without checks cannot also expect check results.',
      });
  });
export type DelegationVerification = z.infer<typeof DelegationVerification>;
