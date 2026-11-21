/**
 * Imported first by main.tsx (module evaluation order): under the page's CSP (no 'unsafe-eval', AP-23) zod must never
 * probe `new Function`, and that probe runs at the first parse — some happen while modules load.
 */
import { z } from 'zod';

if (!import.meta.env.VITE_FIXTURES) z.config({ jitless: true });
