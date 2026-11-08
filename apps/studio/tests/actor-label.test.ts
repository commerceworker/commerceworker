// Who wrote something, in words: an entry's creator and last editor, an asset version's uploader.
// Names when the team is known, "You" for the signed-in person, the kind of writer otherwise,
// and never a raw id.
import { describe, expect, it } from 'vitest';
import { actorLabel } from '~/cms/lib/authorship';

const people = [
  { id: 'u-ada', email: 'ada@example.com', name: 'Ada Lovelace' },
  { id: 'u-grace', email: 'grace@example.com' },
];

describe('actorLabel', () => {
  it('reads every kind of writer as words', () => {
    const dir = { me: 'u-me', people };
    expect(actorLabel('u-me', dir)).toBe('You');
    expect(actorLabel('u-ada', dir)).toBe('Ada Lovelace');
    expect(actorLabel('u-grace', dir)).toBe('grace@example.com');
    expect(actorLabel('u-unknown', dir)).toBe('A teammate');
    expect(actorLabel('admin-token')).toBe('The admin token');
    expect(actorLabel('cma')).toBe('An API key');
    expect(actorLabel('agent:enrich')).toBe('The enrich agent');
    expect(actorLabel('workflow:0190-wf')).toBe('A workflow');
    expect(actorLabel('plugin:seo')).toBe('A plugin');
    expect(actorLabel('system')).toBe('A schedule');
    expect(actorLabel(null)).toBe('Unknown');
  });

  it('runs on from other words in its in-sentence form, leaving names as they are', () => {
    const inSentence = (actor: string, dir = {}) => actorLabel(actor, dir, 'inSentence');
    expect(inSentence('u-ada', { people })).toBe('Ada Lovelace');
    expect(inSentence('u-grace', { people })).toBe('grace@example.com');
    expect(inSentence('u-me', { me: 'u-me' })).toBe('you');
    expect(inSentence('cma')).toBe('an API key');
    expect(inSentence('admin-token')).toBe('the admin token');
    expect(inSentence('agent:enrich')).toBe('the enrich agent');
    expect(inSentence('0193f1e2-7c4a-7000-8000-000000000000')).toBe('a teammate');
    expect(inSentence('ada@example.com')).toBe('ada@example.com');
  });
});
