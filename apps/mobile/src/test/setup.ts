import { failOnLeftOut } from '@whombat/client/testing/contract-tripwire';

// A fake answer that no longer matches the contract fails its test (`expectLeftOut` for a test about it).
failOnLeftOut();
