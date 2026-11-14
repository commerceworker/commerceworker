import { InMemoryAdminPasswordResets } from '../src/admin-password-resets';
import {
  describeAdminPasswordResetsContract,
  RESET_FIXTURE,
} from '../src/admin-password-resets-contract';

describeAdminPasswordResetsContract('in memory', async () => {
  const store = new InMemoryAdminPasswordResets(RESET_FIXTURE);
  return { resets: store, auth: store };
});
