import { InMemoryAdminTeam } from '../src/admin-team';
import { ADMIN_TEAM_FIXTURE, describeAdminTeamContract } from '../src/admin-team-contract';

describeAdminTeamContract('in memory', async () => {
  const store = new InMemoryAdminTeam();
  for (const u of ADMIN_TEAM_FIXTURE) {
    await store.addUser({
      ...u,
      passwordHash: 'hash',
      passwordChangeDue: false,
      passwordExpiresAt: null,
    });
    if (u.disabledAt) await store.setDisabled(u.id, u.disabledAt);
  }
  return store;
});
