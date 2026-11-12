import { test as setup } from '@playwright/test';
import { seedPlaced } from './placed-seed';

/**
 * Runs once, after every other device spec has finished: publishes the checkout flow the
 * placed-order spec needs (see placed-seed.ts for why not in the global setup).
 */
setup('publish the hosted checkout flow', () => {
  seedPlaced();
});
