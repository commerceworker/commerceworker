import { describe, expect, it } from 'vitest';
import { mockBlockMove, mockModel, mockStep } from '../../src/assistant/model';

const onEntry = {
  scope: { spaceId: 'sp_1', environmentId: 'main' },
  page: { kind: 'entry', entryId: 'e1', contentType: 'page', label: 'Home' },
} as const;
const TOOLS = new Set(['entry_blocks_outline', 'entry_blocks_patch', 'entries_trash']);
const ASK = 'Move the first block to the end';

const outline = {
  entryId: 'e1',
  version: 4,
  fields: {
    sidebar: { 'en-US': [{ key: 'only' }] },
    body: { 'en-US': [{ key: 'k1' }, { key: 'k2' }, { key: 'k3' }] },
  },
};

describe('a block move without the language model (the mock)', () => {
  it('outlines the entry first, since a move needs its keys and version', () => {
    expect(mockStep(ASK, onEntry, TOOLS)).toEqual({
      tool: 'entry_blocks_outline',
      input: { id: 'e1' },
    });
    // "remove" is not "move": that is still the trash.
    expect(mockStep('Remove this entry', onEntry, TOOLS)).toMatchObject({ tool: 'entries_trash' });
  });

  it('moves the first block of the first field holding two, held to the outlined version', () => {
    expect(mockBlockMove('e1', outline)).toEqual({
      tool: 'entry_blocks_patch',
      input: {
        id: 'e1',
        expectedVersion: 4,
        ops: [{ op: 'move', field: 'body', locale: 'en-US', key: 'k1', to: { index: 2 } }],
      },
    });
    expect(
      mockBlockMove('e1', { version: 4, fields: { body: { 'en-US': [{ key: 'k1' }] } } }),
    ).toBe(null);
    expect(mockBlockMove('e1', 'not an outline')).toBe(null);
  });

  it('turns the outline it read into the proposed patch', async () => {
    const model = mockModel(onEntry);
    const res = await model.doGenerate({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: ASK }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'entry_blocks_outline', input: {} },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'entry_blocks_outline',
              output: {
                type: 'text',
                value: `<user_content>\n${JSON.stringify(outline)}\n</user_content>`,
              },
            },
          ],
        },
      ],
      tools: [...TOOLS].map((name) => ({ type: 'function', name, inputSchema: {} })),
    } as never);
    const call = res.content[0] as { type: string; toolName?: string; input?: string };
    expect(call.type).toBe('tool-call');
    expect(call.toolName).toBe('entry_blocks_patch');
    expect(JSON.parse(call.input ?? '{}')).toMatchObject({ id: 'e1', expectedVersion: 4 });
  });
});
