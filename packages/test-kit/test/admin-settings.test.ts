import { InMemoryAdminSettings } from '../src/admin-settings';
import { describeAdminSettingsContract } from '../src/admin-settings-contract';

describeAdminSettingsContract('in memory', async () => new InMemoryAdminSettings());
