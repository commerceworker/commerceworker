import {
  addMember,
  createContentType,
  createEntry,
  createEnvironment,
  createRole,
  findMemberForSignIn,
  publishContentType,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import type { FieldDefinition } from '@commerceworker/domain';
import { principalTarget, signPrincipal } from '@commerceworker/security/principal';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app';
import { testConfig } from './config';
import { wire } from './wire';

const KEY = 'test-principal-key-0123456789abcdef';
const config = testConfig({ principalKeys: [KEY] });
const M = '/spaces/s1/environments/main';
const scope = { spaceId: 's1', environmentId: 'main' };

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

type Who = { sub: string; email: string; name: string; role: 'admin' | 'member' };
const who = (sub: string): Who => ({ sub, email: `${sub}@example.com`, name: sub, role: 'member' });
const lead = who('lead');
const writer = who('writer');
const nosy = who('nosy');
const pagesOnly = who('pages');

type View = {
  id: string;
  name: string;
  revision: number;
  visibility?: string;
  columns?: string[];
  createdBy: string;
};
type Run = {
  items: { contentType: string; fields: Record<string, Record<string, unknown>> }[];
  total: number;
  ignored?: string[];
};

describe('saved views over HTTP', () => {
  let app: ReturnType<typeof createApp>;
  let ctx: ReturnType<typeof wire>['ctx'];

  beforeEach(async () => {
    const wired = wire(config);
    const { rag, blob, ai } = wired;
    ctx = wired.ctx;
    app = createApp(ctx, config, rag, blob, ai);
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'staff',
      name: 'Staff',
      displayField: 'name',
      fields: [
        field({ apiId: 'name', type: 'Symbol' }),
        field({ apiId: 'team', type: 'Symbol', position: 1 }),
        field({ apiId: 'salary', type: 'Integer', position: 2 }),
      ],
    });
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      apiId: 'memo',
      name: 'Memo',
      displayField: 'name',
      fields: [field({ apiId: 'name', type: 'Symbol' })],
    });
    await publishContentType(ctx, scope, 'staff');
    await publishContentType(ctx, scope, 'memo');
    for (const [name, team, salary] of [
      ['Ana', 'web', 100],
      ['Ben', 'web', 200],
      ['Cy', 'ops', 300],
    ] as const) {
      await createEntry(ctx, scope, {
        contentTypeApiId: 'staff',
        fields: {
          name: { 'en-US': name },
          team: { 'en-US': team },
          salary: { 'en-US': salary },
        },
      });
    }
    await createEntry(ctx, scope, {
      contentTypeApiId: 'memo',
      fields: { name: { 'en-US': 'Hello' } },
    });
    // A manager shares views; a writer keeps their own; one role can't read salaries, another
    // reads memos only.
    const noSalary = await createRole(ctx, 's1', {
      name: 'No salaries',
      scopes: ['preview:read', 'content:write'],
      contentGrants: [
        { contentTypeApiId: '*', actions: ['read', 'write'], deniedFields: ['salary'] },
      ],
    } as Parameters<typeof createRole>[2]);
    const memos = await createRole(ctx, 's1', {
      name: 'Memos',
      scopes: ['preview:read'],
      contentGrants: [{ contentTypeApiId: 'memo', actions: ['read'] }],
    } as Parameters<typeof createRole>[2]);
    for (const [person, role] of [
      [lead, 'manager'],
      [writer, 'editor'],
      [nosy, noSalary.id],
      [pagesOnly, memos.id],
    ] as const) {
      await addMember(ctx, 's1', { email: person.email, role });
      await findMemberForSignIn(ctx, 's1', person.sub, person.email);
    }
  });

  const call = async (as: Who, method: string, path: string, body?: unknown) => {
    const target = `${M}${path}`;
    const url = new URL(target, 'http://x');
    return app.request(target, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-cw-principal': await signPrincipal(KEY, as, principalTarget(method, url.pathname)),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  };
  const create = async (as: Who, body: unknown) => {
    const res = await call(as, 'POST', '/saved-views', body);
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as View;
  };
  const names = async (as: Who, qs = '') =>
    ((await (await call(as, 'GET', `/saved-views${qs}`)).json()) as { items: View[] }).items.map(
      (v) => v.name,
    );

  it('creates, lists, gets, runs, changes and deletes a view', async () => {
    const view = await create(writer, {
      name: 'Web team',
      contentTypeApiId: 'staff',
      query: {
        filters: [{ field: 'fields.team', op: 'eq', value: 'web' }],
        order: [{ field: 'name', direction: 'desc' }],
        extra: { assignee: 'me' },
      },
      columns: ['team', 'sys.status'],
    });
    expect(view).toMatchObject({ name: 'Web team', revision: 1, columns: ['team', 'sys.status'] });
    expect(await names(writer, '?content_type=staff')).toEqual(['Web team']);
    expect(await names(writer, '?content_type=memo')).toEqual([]);
    expect((await call(writer, 'GET', `/saved-views/${view.id}`)).status).toBe(200);

    const run = (await (
      await call(writer, 'GET', `/saved-views/${view.id}/entries`)
    ).json()) as Run;
    expect(run.items.map((e) => e.fields.name?.['en-US'])).toEqual(['Ben', 'Ana']);
    expect(run).toMatchObject({ total: 2, ignored: ['assignee'] });
    const page = (await (
      await call(writer, 'GET', `/saved-views/${view.id}/entries?limit=1`)
    ).json()) as Run & { nextCursor?: string };
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();

    const renamed = await call(writer, 'PATCH', `/saved-views/${view.id}`, {
      name: 'Web',
      revision: 1,
    });
    expect(renamed.status).toBe(200);
    expect(
      (await call(writer, 'PATCH', `/saved-views/${view.id}`, { name: 'Late', revision: 1 }))
        .status,
    ).toBe(409);
    expect((await call(writer, 'DELETE', `/saved-views/${view.id}?revision=2`)).status).toBe(204);
    expect((await call(writer, 'GET', `/saved-views/${view.id}`)).status).toBe(404);
  });

  it('answers 404 for another person’s personal view, on every route', async () => {
    const view = await create(writer, { name: 'Mine', contentTypeApiId: 'staff' });
    expect(await names(lead)).toEqual([]);
    for (const [method, path, body] of [
      ['GET', `/saved-views/${view.id}`],
      ['GET', `/saved-views/${view.id}/entries`],
      ['PATCH', `/saved-views/${view.id}`, { name: 'Taken' }],
      ['DELETE', `/saved-views/${view.id}`],
    ] as const) {
      expect((await call(lead, method, path, body)).status, `${method} ${path}`).toBe(404);
    }
  });

  it('needs content:manage for anything shared', async () => {
    expect(
      (await call(writer, 'POST', '/saved-views', { name: 'All', visibility: 'shared' })).status,
    ).toBe(403);
    const mine = await create(writer, { name: 'Mine' });
    expect(
      (await call(writer, 'PATCH', `/saved-views/${mine.id}`, { visibility: 'shared' })).status,
    ).toBe(403);
    const shared = await create(lead, { name: 'Team', visibility: 'shared' });
    expect(await names(writer)).toEqual(['Mine', 'Team']);
    expect((await call(writer, 'PATCH', `/saved-views/${shared.id}`, { name: 'X' })).status).toBe(
      403,
    );
    expect((await call(writer, 'DELETE', `/saved-views/${shared.id}`)).status).toBe(403);
    expect(
      (await call(lead, 'PATCH', `/saved-views/${mine.id}`, { visibility: 'shared' })).status,
    ).toBe(404);
  });

  it('lets only a shared view’s creator stop sharing it, as a fresh read shows', async () => {
    const shared = await create(lead, { name: 'Team', visibility: 'shared' });
    await addMember(ctx, 's1', { email: 'rival@example.com', role: 'manager' });
    await findMemberForSignIn(ctx, 's1', 'rival', 'rival@example.com');
    const rival = who('rival');

    const refused = await call(rival, 'PATCH', `/saved-views/${shared.id}`, {
      visibility: 'personal',
    });
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain('Only the person who created a shared view');
    expect(await names(writer)).toEqual(['Team']);

    const done = await call(lead, 'PATCH', `/saved-views/${shared.id}`, { visibility: 'personal' });
    expect(done.status).toBe(200);
    const read = (await (await call(lead, 'GET', `/saved-views/${shared.id}`)).json()) as View;
    expect(read).toMatchObject({ visibility: 'personal', createdBy: shared.createdBy });
    expect(await names(writer)).toEqual([]);
    expect(await names(lead)).toEqual(['Team']);
  });

  it('keeps columns a role hides when that role saves over a shared view', async () => {
    const shared = await create(lead, {
      name: 'Pay',
      contentTypeApiId: 'staff',
      visibility: 'shared',
      columns: ['salary', 'team'],
    });
    const role = await createRole(ctx, 's1', {
      name: 'Managers without salaries',
      scopes: ['preview:read', 'content:manage'],
      contentGrants: [{ contentTypeApiId: '*', actions: ['read'], deniedFields: ['salary'] }],
    } as Parameters<typeof createRole>[2]);
    await addMember(ctx, 's1', { email: 'hide2@example.com', role: role.id });
    await findMemberForSignIn(ctx, 's1', 'hide2', 'hide2@example.com');

    const res = await call(who('hide2'), 'PATCH', `/saved-views/${shared.id}`, {
      columns: ['sys.status'],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as View).columns).toEqual(['sys.status']);
    const read = (await (await call(lead, 'GET', `/saved-views/${shared.id}`)).json()) as View;
    expect(read.columns).toEqual(['salary', 'sys.status']);
  });

  it('reports a view whose type this environment lacks, and still changes and deletes it', async () => {
    const view = await create(writer, {
      name: 'Staff',
      contentTypeApiId: 'staff',
      columns: ['team'],
    });
    await createEnvironment(ctx, 's1', 'empty');
    const inEmpty = async (method: string, path: string, body?: unknown) => {
      const target = `/spaces/s1/environments/empty${path}`;
      return app.request(target, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-cw-principal': await signPrincipal(
            KEY,
            writer,
            principalTarget(method, new URL(target, 'http://x').pathname),
          ),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    };
    const run = await inEmpty('GET', `/saved-views/${view.id}/entries`);
    expect(run.status).toBe(200);
    expect(await run.json()).toMatchObject({ items: [], total: 0, typeMissing: true });
    const ok = await call(writer, 'GET', `/saved-views/${view.id}/entries`);
    expect(((await ok.json()) as Run & { typeMissing?: true }).typeMissing).toBeUndefined();

    expect((await inEmpty('PATCH', `/saved-views/${view.id}`, { columns: ['team'] })).status).toBe(
      422,
    );
    expect((await inEmpty('PATCH', `/saved-views/${view.id}`, { columns: null })).status).toBe(200);
    expect((await inEmpty('DELETE', `/saved-views/${view.id}`)).status).toBe(204);
  });

  it('never widens what a viewer sees: a shared view runs under the viewer’s role', async () => {
    const all = await create(lead, {
      name: 'Everyone',
      contentTypeApiId: 'staff',
      visibility: 'shared',
      columns: ['team', 'salary'],
    });
    const rich = await create(lead, {
      name: 'Well paid',
      contentTypeApiId: 'staff',
      visibility: 'shared',
      query: { where: { or: [{ field: 'salary', op: 'gt', value: 150 }] } },
    });
    const sorted = await create(lead, {
      name: 'By salary',
      contentTypeApiId: 'staff',
      visibility: 'shared',
      query: { order: [{ field: 'salary', direction: 'desc' }] },
    });
    const everything = await create(lead, { name: 'Anything', visibility: 'shared' });

    // The manager sees every view, and salaries.
    const full = (await (await call(lead, 'GET', `/saved-views/${all.id}/entries`)).json()) as Run;
    expect(full.items.every((e) => e.fields.salary !== undefined)).toBe(true);

    // Salaries hidden: views that filter or sort by salary aren't there; the rest run masked.
    expect(await names(nosy)).toEqual(['Anything', 'Everyone']);
    for (const id of [rich.id, sorted.id]) {
      expect((await call(nosy, 'GET', `/saved-views/${id}`)).status).toBe(404);
      expect((await call(nosy, 'GET', `/saved-views/${id}/entries`)).status).toBe(404);
    }
    const shown = (await (await call(nosy, 'GET', `/saved-views/${all.id}`)).json()) as View;
    expect(shown.columns).toEqual(['team']);
    const masked = (await (
      await call(nosy, 'GET', `/saved-views/${all.id}/entries`)
    ).json()) as Run;
    expect(masked.items).toHaveLength(3);
    expect(masked.items.every((e) => e.fields.salary === undefined)).toBe(true);
    // Nor can they save a view that asks about salaries.
    expect(
      (
        await call(nosy, 'POST', '/saved-views', {
          name: 'Peek',
          contentTypeApiId: 'staff',
          query: { filters: [{ field: 'salary', op: 'gt', value: 1 }] },
        })
      ).status,
    ).toBe(403);

    // Memos only: no staff view at all, and the view over every type lists memos alone.
    expect(await names(pagesOnly)).toEqual(['Anything']);
    expect((await call(pagesOnly, 'GET', `/saved-views/${all.id}/entries`)).status).toBe(404);
    const memos = (await (
      await call(pagesOnly, 'GET', `/saved-views/${everything.id}/entries`)
    ).json()) as Run;
    expect(memos.items.map((e) => e.contentType)).toEqual(['memo']);
  });

  it('answers a where too deep to read, or a known key in extra, with a 422', async () => {
    const raw = `{"name":"Deep","query":{"where":${'{"or":['.repeat(50_000)}{"field":"name","op":"eq","value":"a"}${']}'.repeat(50_000)}}}`;
    const res = await app.request(`${M}/saved-views`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cw-principal': await signPrincipal(
          KEY,
          writer,
          principalTarget('POST', `${M}/saved-views`),
        ),
      },
      body: raw,
    });
    expect(res.status).toBe(422);
    const deepField = await app.request(`${M}/saved-views`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cw-principal': await signPrincipal(
          KEY,
          writer,
          principalTarget('POST', `${M}/saved-views`),
        ),
      },
      body: `{"name":"Deep","query":{"filters":[{"op":"eq","field":${'['.repeat(50_000)}${']'.repeat(50_000)}}]}}`,
    });
    expect(deepField.status).toBe(422);
    const known = await call(writer, 'POST', '/saved-views', {
      name: 'Sneaky',
      query: { extra: { where: '{"field":"salary","op":"gt","value":0}' } },
    });
    expect(known.status).toBe(422);
    expect(await known.text()).toContain('query.extra');
  });

  it('refuses a malformed query with 422, naming the part', async () => {
    const res = await call(writer, 'POST', '/saved-views', {
      name: 'Bad',
      contentTypeApiId: 'staff',
      query: { where: { or: [{ field: 'name', op: 'between', value: ['a'] }] } },
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('query.where.or[0]');
  });
});
