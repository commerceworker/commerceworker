import { SETUP_SCOPE } from '@commerceworker/domain';
import { describe, expect, it } from 'vitest';
import { readContext } from '../../src/assistant/context';
import { mockStep, spaceNameFrom } from '../../src/assistant/model';

const SETUP_TOOLS = new Set(['space_starters_list', 'space_create']);
const setup = { scope: SETUP_SCOPE, page: { kind: 'everything' } } as const;

describe('a turn with no space', () => {
  it('reads the setup scope as its own, about no page', () => {
    expect(
      readContext({ scope: { spaceId: '*', environmentId: '*' }, page: { kind: 'entry' } }),
    ).toEqual(setup);
    // Half of it is no scope at all.
    expect(readContext({ scope: { spaceId: '*', environmentId: 'main' } })).toBeNull();
  });

  it('names a space from what it is for', () => {
    expect(spaceNameFrom('A marketing site')).toBe('Marketing site');
    expect(spaceNameFrom('it’s for our docs hub, with sample content')).toBe('Docs hub');
    expect(spaceNameFrom('Something called "Aldermoor Journal".')).toBe('Aldermoor Journal');
    expect(spaceNameFrom('   ')).toBe('My first space');
  });

  it('proposes one space, with the starter the words point to (the mock model)', () => {
    expect(mockStep('A product catalog', setup, SETUP_TOOLS)).toEqual({
      tool: 'space_create',
      input: {
        name: 'Product catalog',
        spaceId: 'product-catalog',
        defaultLocale: 'en-US',
        starter: 'sample',
      },
    });
    expect(mockStep('An empty space for recipes', setup, SETUP_TOOLS)).toMatchObject({
      input: { starter: 'empty' },
    });
    expect(mockStep('?', setup, SETUP_TOOLS)).toHaveProperty('text');
  });
});
