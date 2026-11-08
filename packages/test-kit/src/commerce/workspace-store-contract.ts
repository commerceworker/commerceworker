/**
 * The behaviour every `WorkspaceStore` keeps: the in-memory store runs it in node and the D1 store
 * in workerd (packages/db). Ids start `ws_`.
 */
import type { WorkspaceStore } from '@commerceworker/ports/commerce';
import { describe, expect, it } from 'vitest';
import type { WorkspaceFixture } from './workspace-store';

const member = (id: string, role: string, disabledAt: number | null = null) => ({
  id,
  email: `${id}@example.com`,
  name: id,
  role,
  disabledAt,
});

export const WORKSPACE_FIXTURE: WorkspaceFixture = {
  members: [
    member('ws_ada', 'admin'),
    member('ws_grace', 'admin', 5),
    member('ws_lin', 'approver'),
  ],
  tokens: [
    { id: 'ws_t_admin', role: 'admin', createdById: 'ws_lin', createdBy: 'ws_lin@example.com' },
    { id: 'ws_t_old', role: 'admin', createdById: null, createdBy: 'ws_lin@example.com' },
    { id: 'ws_t_viewer', role: 'viewer', createdById: 'ws_lin', createdBy: 'ws_lin@example.com' },
    { id: 'ws_t_other', role: 'admin', createdById: 'ws_ada', createdBy: 'ws_ada@example.com' },
  ],
};

export function describeWorkspaceStoreContract(
  name: string,
  make: (fixture: WorkspaceFixture) => Promise<WorkspaceStore>,
) {
  describe(`${name}: the workspace store contract`, () => {
    const fresh = () => make(WORKSPACE_FIXTURE);

    it('reads members and whether another active admin remains', async () => {
      const w = await fresh();
      expect(await w.member('ws_lin')).toEqual(member('ws_lin', 'approver'));
      expect(await w.member('ws_none')).toBeUndefined();
      // Grace is an admin but disabled: Ada is the only active one.
      expect(await w.hasOtherAdmin('ws_ada')).toBe(false);
      expect(await w.hasOtherAdmin('ws_lin')).toBe(true);
    });

    it('refuses to take admin from the last active admin, and makes another', async () => {
      const w = await fresh();
      expect(await w.setRole('ws_ada', 'approver')).toBe(false);
      expect((await w.member('ws_ada'))?.role).toBe('admin');
      expect(await w.setRole('ws_lin', 'admin')).toBe(true);
      expect(await w.setRole('ws_ada', 'approver')).toBe(true);
      expect((await w.member('ws_ada'))?.role).toBe('approver');
    });

    it("revokes a member's live tokens above a role, once, including ones named by email", async () => {
      const w = await fresh();
      const lin = { id: 'ws_lin', email: 'ws_lin@example.com' };
      expect(await w.revokeTokens(lin, ['admin'])).toBe(2);
      expect(await w.revokeTokens(lin, ['admin'])).toBe(0);
      expect(await w.revokeTokens(lin, [])).toBe(0);
      expect(await w.revokeTokens(lin, null)).toBe(1);
      expect(await w.revokeTokens(lin, null)).toBe(0);
    });

    it('lists active admins by name, and names members', async () => {
      const w = await fresh();
      expect(await w.admins(3)).toEqual([{ name: 'ws_ada', email: 'ws_ada@example.com' }]);
      expect((await w.names(['ws_lin', 'ws_none', 'ws_ada'])).map((m) => m.id).sort()).toEqual([
        'ws_ada',
        'ws_lin',
      ]);
    });

    it('lists the team by email, and every token newest first without its hash', async () => {
      const w = await make({
        members: [
          { ...member('ws_zed', 'viewer'), createdAt: 7, lastLoginAt: 9, passwordChangeDue: true },
          { ...member('ws_amy', 'admin'), createdAt: 3, twoFactorAt: 4 },
        ],
        tokens: [
          {
            id: 'ws_t_1',
            role: 'viewer',
            createdById: 'ws_amy',
            createdBy: 'ws_amy@example.com',
            name: 'ERP sync',
            prefix: 'cmw_live_ab',
            createdAt: 10,
            expiresAt: 99,
          },
          {
            id: 'ws_t_2',
            role: 'admin',
            createdById: 'ws_amy',
            createdBy: 'ws_amy@example.com',
            createdAt: 20,
          },
        ],
      });
      const { people, tokens } = await w.team();
      expect(people).toEqual([
        {
          ...member('ws_amy', 'admin'),
          createdAt: 3,
          lastLoginAt: null,
          twoFactorAt: 4,
          passwordChangeDue: false,
        },
        {
          ...member('ws_zed', 'viewer'),
          createdAt: 7,
          lastLoginAt: 9,
          twoFactorAt: null,
          passwordChangeDue: true,
        },
      ]);
      expect(tokens.map((t) => t.id)).toEqual(['ws_t_2', 'ws_t_1']);
      expect(tokens[1]).toEqual({
        id: 'ws_t_1',
        name: 'ERP sync',
        prefix: 'cmw_live_ab',
        role: 'viewer',
        createdBy: 'ws_amy@example.com',
        createdAt: 10,
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: 99,
      });
    });

    it('disables and enables a member', async () => {
      const w = await fresh();
      await w.setDisabled('ws_lin', 42);
      expect((await w.member('ws_lin'))?.disabledAt).toBe(42);
      await w.setDisabled('ws_lin', null);
      expect((await w.member('ws_lin'))?.disabledAt).toBeNull();
    });

    it('adds a token, and revokes a live one once', async () => {
      const w = await fresh();
      await w.addToken({
        id: 'ws_t_new',
        name: 'Feed',
        prefix: 'cmw_live_zz',
        tokenHash: 'ws_hash_new',
        role: 'operator',
        createdBy: 'ws_ada@example.com',
        createdById: 'ws_ada',
        createdAt: 50,
        expiresAt: null,
      });
      expect((await w.team()).tokens[0]).toMatchObject({ id: 'ws_t_new', revokedAt: null });
      expect(await w.revokeToken('ws_t_new', 60)).toEqual({ name: 'Feed', prefix: 'cmw_live_zz' });
      expect(await w.revokeToken('ws_t_new', 70)).toBeUndefined();
      expect(await w.revokeToken('ws_t_none', 70)).toBeUndefined();
      expect((await w.team()).tokens.find((t) => t.id === 'ws_t_new')?.revokedAt).toBe(60);
    });

    it('reads when and by whom a setting was set, and clears it', async () => {
      const w = await fresh();
      expect(await w.settingRecord('ws_token')).toBeUndefined();
      await w.setSetting('ws_token', 'hash-1', 'ada@example.com');
      expect(await w.settingRecord('ws_token')).toEqual({
        value: 'hash-1',
        updatedAt: expect.any(Number),
        updatedBy: 'ada@example.com',
      });
      await w.clearSetting('ws_token');
      expect(await w.setting('ws_token')).toBeUndefined();
      await w.clearSetting('ws_token');
    });

    it('reads and sets settings', async () => {
      const w = await fresh();
      expect(await w.setting('ws_setting')).toBeUndefined();
      await w.setSetting('ws_setting', 'on', 'ada@example.com');
      await w.setSetting('ws_setting', 'off', 'ada@example.com');
      expect(await w.setting('ws_setting')).toBe('off');
      expect(await w.claimSetting('ws_code', 'hash-1', 'ada')).toBe(true);
      expect(await w.claimSetting('ws_code', 'hash-1', 'ada')).toBe(false);
      expect(await w.claimSetting('ws_code', 'hash-2', 'ada')).toBe(true);
      await w.restoreSetting('ws_code', 'hash-1');
      expect(await w.setting('ws_code')).toBe('hash-1');
      await w.restoreSetting('ws_code', undefined);
      expect(await w.setting('ws_code')).toBeUndefined();
    });
  });
}
