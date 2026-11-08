import { describe, expect, it } from 'vitest';
import {
  applyBlockPatch,
  type BlockOp,
  type BlockPatchResult,
  blockAtPath,
  type ComponentVariant,
  type ContentType,
  defineContentType,
  type EntryFields,
  type FieldDefinition,
  invertBlockPatch,
  outlineBlocks,
  validateEntryFields,
} from '../src/index';

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;

const blocks = (apiId: string, variants: readonly ComponentVariant[], position = 0) =>
  field({ apiId, type: 'Array', position, items: { type: 'Component', variants } });

const HERO: ComponentVariant = {
  apiId: 'hero',
  name: 'Hero',
  fields: [
    field({ apiId: 'heading', type: 'Symbol' }),
    field({ apiId: 'tagline', type: 'Symbol', position: 1 }),
  ],
};
const CTA: ComponentVariant = {
  apiId: 'cta',
  name: 'Call to action',
  fields: [field({ apiId: 'label', type: 'Symbol' })],
};
// A section holds heroes and calls to action, never another section.
const SECTION: ComponentVariant = {
  apiId: 'section',
  name: 'Section',
  fields: [
    field({ apiId: 'title', type: 'Symbol' }),
    blocks('items', [HERO, CTA], 1),
    // Blocks under a plain component: carried along, not addressable.
    field({
      apiId: 'aside',
      type: 'Component',
      position: 2,
      fields: [blocks('notes', [CTA])],
    }),
  ],
};

const LANDING: ContentType = defineContentType({
  apiId: 'landing',
  name: 'Landing',
  displayField: 'title',
  fields: [field({ apiId: 'title', type: 'Symbol' }), blocks('body', [HERO, CTA, SECTION], 1)],
});

const L = 'en-US';
const vctx = { defaultLocale: L, locales: [L] };

/** A page: a hero, a section holding a hero and a call to action, and a closing call to action. */
const page = (): EntryFields => ({
  title: { [L]: 'Home' },
  body: {
    [L]: [
      { _type: 'hero', _key: 'h1', heading: 'Welcome' },
      {
        _type: 'section',
        _key: 's1',
        title: 'Features',
        items: [
          { _type: 'hero', _key: 'h2', heading: 'Fast' },
          { _type: 'cta', _key: 'c1', label: 'Try it' },
        ],
        aside: { notes: [{ _type: 'cta', _key: 'n1', label: 'Note' }] },
      },
      { _type: 'cta', _key: 'c2', label: 'Sign up' },
    ],
  },
});

const keyMinter = () => {
  let n = 0;
  return () => `k${++n}`;
};

const at = { field: 'body', locale: L } as const;

function apply(ops: readonly BlockOp[], fields = page()) {
  return applyBlockPatch(LANDING, fields, ops, keyMinter());
}
function applied(ops: readonly BlockOp[], fields = page()) {
  const result = apply(ops, fields);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result;
}
function refused(ops: readonly BlockOp[], fields = page()) {
  const result: BlockPatchResult = apply(ops, fields);
  if (result.ok) throw new Error('expected the patch to be refused');
  return result.issues;
}

type Node = { _key?: string; _type?: string; [k: string]: unknown };
const body = (fields: EntryFields) => fields.body?.[L] as Node[];
const keysOf = (items: readonly Node[]) => items.map((b) => b._key);
const section = (fields: EntryFields) => body(fields).find((b) => b._key === 's1') as Node;
const items = (fields: EntryFields) => section(fields).items as Node[];

describe('inserting a block', () => {
  it('appends at the end of the field by default and mints its key', () => {
    const r = applied([{ op: 'insert', ...at, block: { _type: 'cta', label: 'More' } }]);
    expect(keysOf(body(r.fields))).toEqual(['h1', 's1', 'c2', 'k1']);
    expect(body(r.fields)[3]).toEqual({ _type: 'cta', label: 'More', _key: 'k1' });
  });

  it('places it before or after a sibling, or at an index', () => {
    const block = { _type: 'cta', label: 'x' };
    expect(keysOf(body(applied([{ op: 'insert', ...at, before: 's1', block }]).fields))).toEqual([
      'h1',
      'k1',
      's1',
      'c2',
    ]);
    expect(keysOf(body(applied([{ op: 'insert', ...at, after: 's1', block }]).fields))).toEqual([
      'h1',
      's1',
      'k1',
      'c2',
    ]);
    expect(keysOf(body(applied([{ op: 'insert', ...at, index: 0, block }]).fields))).toEqual([
      'k1',
      'h1',
      's1',
      'c2',
    ]);
  });

  it('inserts into a parent block’s slot, and names the new block by its ref', () => {
    const r = applied([
      {
        op: 'insert',
        ...at,
        parent: { key: 's1', slot: 'items' },
        after: 'h2',
        block: { _type: 'cta', label: 'Docs' },
        ref: 'docs',
      },
    ]);
    expect(keysOf(items(r.fields))).toEqual(['h2', 'k1', 'c1']);
    expect(r.keys).toEqual({ docs: 'k1' });
  });

  it('lets a later op address a new block by its ref', () => {
    const r = applied([
      { op: 'insert', ...at, block: { _type: 'section', title: 'More' }, ref: 'more' },
      {
        op: 'insert',
        ...at,
        parent: { key: 'more', slot: 'items' },
        block: { _type: 'hero', heading: 'Inside' },
        ref: 'inside',
      },
      { op: 'update', ...at, key: 'inside', set: { tagline: 'set by ref' } },
    ]);
    expect(r.keys).toEqual({ more: 'k1', inside: 'k2' });
    expect(body(r.fields)[3]).toEqual({
      _type: 'section',
      _key: 'k1',
      title: 'More',
      items: [{ _type: 'hero', _key: 'k2', heading: 'Inside', tagline: 'set by ref' }],
    });
    // The applied ops name keys, never refs.
    expect(r.applied[1]).toMatchObject({ parent: { key: 'k1', slot: 'items' } });
    expect(r.applied[2]).toMatchObject({ key: 'k2' });
  });

  it('keys the blocks inside an inserted block too, keeping keys no block holds yet', () => {
    const r = applied([
      {
        op: 'insert',
        ...at,
        block: {
          _type: 'section',
          _key: 'mine',
          items: [{ _type: 'hero', heading: 'a' }],
          aside: { notes: [{ _type: 'cta', label: 'n' }] },
        },
      },
    ]);
    const inserted = body(r.fields)[3] as Node;
    expect(inserted._key).toBe('mine');
    expect((inserted.items as Node[])[0]?._key).toBe('k1');
    expect(((inserted.aside as Node).notes as Node[])[0]?._key).toBe('k2');
  });

  it('refuses a key a block already holds, anywhere in the field', () => {
    expect(
      refused([{ op: 'insert', ...at, block: { _type: 'cta', _key: 'c1', label: 'x' } }]),
    ).toEqual([
      {
        op: 0,
        field: 'ops[0]',
        locale: L,
        // The block that holds it, by its key: a client names it from its own read.
        code: 'key_taken',
        key: 'c1',
        message: '_key "c1" is already held by a block in body (en-US)',
      },
    ]);
  });

  it('refuses a type the slot doesn’t admit, at the top and in a slot', () => {
    expect(refused([{ op: 'insert', ...at, block: { _type: 'banner' } }])[0]?.message).toBe(
      'A "banner" block can’t go here (one of: hero, cta, section)',
    );
    expect(
      refused([
        {
          op: 'insert',
          ...at,
          parent: { key: 's1', slot: 'items' },
          block: { _type: 'section' },
        },
      ])[0]?.message,
    ).toBe('A "section" block can’t go here (one of: hero, cta)');
    expect(refused([{ op: 'insert', ...at, block: { label: 'x' } }])[0]?.message).toBe(
      'The block has no _type (one of: hero, cta, section)',
    );
  });

  it('refuses a slot the parent’s type doesn’t declare, and a parent with no slots', () => {
    expect(
      refused([
        { op: 'insert', ...at, parent: { key: 's1', slot: 'title' }, block: { _type: 'cta' } },
      ])[0]?.message,
    ).toBe('"title" is not a blocks field of "section" blocks');
    expect(
      refused([
        { op: 'insert', ...at, parent: { key: 'h1', slot: 'items' }, block: { _type: 'cta' } },
      ])[0]?.message,
    ).toBe('"items" is not a blocks field of "hero" blocks');
  });

  it('refuses a ref reused in the patch or equal to an existing key', () => {
    const block = { _type: 'cta' };
    expect(
      refused([
        { op: 'insert', ...at, block, ref: 'a' },
        { op: 'insert', ...at, block, ref: 'a' },
      ])[0],
    ).toMatchObject({ op: 1, message: 'ref "a" is already used in this patch' });
    expect(refused([{ op: 'insert', ...at, block, ref: 'h1' }])[0]?.message).toBe(
      'ref "h1" is the _key of an existing block',
    );
  });

  it('refuses an index out of range and more than one position', () => {
    const block = { _type: 'cta' };
    expect(refused([{ op: 'insert', ...at, index: 4, block }])[0]?.message).toBe(
      'index must be an integer from 0 to 3',
    );
    expect(refused([{ op: 'insert', ...at, index: 0, after: 'h1', block }])[0]?.message).toBe(
      'Give at most one of before, after and index',
    );
    expect(refused([{ op: 'insert', ...at, before: 'h2', block }])[0]?.message).toBe(
      'Block "h2" is not in the target slot',
    );
  });

  it('creates the field’s value when the entry has none yet', () => {
    const r = applied([{ op: 'insert', ...at, block: { _type: 'hero' } }], { title: { [L]: 'x' } });
    expect(r.fields.body).toEqual({ [L]: [{ _type: 'hero', _key: 'k1' }] });
  });
});

describe('updating a block', () => {
  it('sets and clears only the fields it names', () => {
    const r = applied([
      { op: 'update', ...at, key: 'h2', set: { tagline: 'Really fast' }, unset: ['heading'] },
    ]);
    expect(items(r.fields)[0]).toEqual({ _type: 'hero', _key: 'h2', tagline: 'Really fast' });
    expect(items(r.fields)[1]).toEqual({ _type: 'cta', _key: 'c1', label: 'Try it' });
  });

  it('refuses a field that holds blocks, so their keys change only through structural ops', () => {
    expect(refused([{ op: 'update', ...at, key: 's1', set: { items: [] } }])[0]?.message).toBe(
      '"items" holds blocks: change them with insert, move, remove or duplicate',
    );
    // A plain component with blocks inside it holds keys too.
    expect(refused([{ op: 'update', ...at, key: 's1', unset: ['aside'] }])[0]?.message).toBe(
      '"aside" holds blocks: change them with insert, move, remove or duplicate',
    );
  });

  it('refuses a field the block’s type doesn’t declare, and an empty update', () => {
    expect(refused([{ op: 'update', ...at, key: 'h1', set: { label: 'x' } }])[0]?.message).toBe(
      '"hero" blocks have no field "label"',
    );
    expect(refused([{ op: 'update', ...at, key: 'h1' }])[0]?.message).toBe(
      'Nothing to update: give set or unset',
    );
    expect(
      refused([{ op: 'update', ...at, key: 'h1', set: { heading: 'x' }, unset: ['heading'] }])[0]
        ?.message,
    ).toBe('"heading" is both set and unset');
  });
});

describe('moving a block', () => {
  it('moves within its slot, judging the place without the block itself', () => {
    expect(
      keysOf(body(applied([{ op: 'move', ...at, key: 'h1', to: { after: 'c2' } }]).fields)),
    ).toEqual(['s1', 'c2', 'h1']);
    expect(
      keysOf(body(applied([{ op: 'move', ...at, key: 'c2', to: { before: 'h1' } }]).fields)),
    ).toEqual(['c2', 'h1', 's1']);
    expect(
      keysOf(body(applied([{ op: 'move', ...at, key: 'h1', to: { index: 2 } }]).fields)),
    ).toEqual(['s1', 'c2', 'h1']);
  });

  it('moves into a slot and back out, with its children', () => {
    const into = applied([
      { op: 'move', ...at, key: 'c2', to: { parent: { key: 's1', slot: 'items' }, index: 0 } },
    ]);
    expect(keysOf(body(into.fields))).toEqual(['h1', 's1']);
    expect(keysOf(items(into.fields))).toEqual(['c2', 'h2', 'c1']);
    const out = applied([{ op: 'move', ...at, key: 'h2', to: { before: 'h1' } }]);
    expect(keysOf(body(out.fields))).toEqual(['h2', 'h1', 's1', 'c2']);
    expect(keysOf(items(out.fields))).toEqual(['c1']);
  });

  it('refuses a move into a block inside it, several levels down', () => {
    const C: ComponentVariant = {
      apiId: 'c',
      name: 'C',
      fields: [field({ apiId: 'label', type: 'Symbol' })],
    };
    const B: ComponentVariant = { apiId: 'b', name: 'B', fields: [blocks('kids', [C])] };
    const A: ComponentVariant = { apiId: 'a', name: 'A', fields: [blocks('kids', [B])] };
    const type = defineContentType({
      apiId: 'tree',
      name: 'Tree',
      displayField: 'title',
      fields: [field({ apiId: 'title', type: 'Symbol' }), blocks('body', [A, B, C], 1)],
    });
    const fields: EntryFields = {
      body: {
        [L]: [
          {
            _type: 'a',
            _key: 'a',
            kids: [{ _type: 'b', _key: 'b', kids: [{ _type: 'c', _key: 'c' }] }],
          },
        ],
      },
    };
    const into = applyBlockPatch(
      type,
      fields,
      [{ op: 'move', ...at, key: 'a', to: { parent: { key: 'b', slot: 'kids' } } }],
      keyMinter(),
    );
    expect(into.ok ? null : into.issues[0]?.message).toBe(
      'A block can’t be moved into itself or a block inside it',
    );
    // The other way round is fine: c up to the top.
    const up = applyBlockPatch(
      type,
      fields,
      [{ op: 'move', ...at, key: 'c', to: { index: 0 } }],
      keyMinter(),
    );
    expect(up.ok && keysOf(up.fields.body?.[L] as Node[])).toEqual(['c', 'a']);
  });

  it('refuses a type the target slot doesn’t admit, and a place relative to itself', () => {
    expect(
      refused([{ op: 'move', ...at, key: 's1', to: { parent: { key: 'h1', slot: 'items' } } }])[0]
        ?.message,
    ).toBe('"items" is not a blocks field of "hero" blocks');
    expect(
      refused([
        {
          op: 'move',
          ...at,
          key: 's1',
          to: { parent: { key: 's1', slot: 'items' }, index: 0 },
        },
      ])[0]?.message,
    ).toBe('A block can’t be moved into itself or a block inside it');
    expect(refused([{ op: 'move', ...at, key: 'h1', to: { after: 'h1' } }])[0]?.message).toBe(
      'A block can’t be placed before or after itself',
    );
  });
});

describe('removing and duplicating a block', () => {
  it('removes a block with everything inside it', () => {
    const r = applied([{ op: 'remove', ...at, key: 's1' }]);
    expect(keysOf(body(r.fields))).toEqual(['h1', 'c2']);
  });

  it('duplicates right after the original, with fresh keys throughout', () => {
    const r = applied([{ op: 'duplicate', ...at, key: 's1', ref: 'copy' }]);
    expect(keysOf(body(r.fields))).toEqual(['h1', 's1', 'k1', 'c2']);
    const copy = body(r.fields)[2] as Node;
    expect(copy.title).toBe('Features');
    expect(keysOf(copy.items as Node[])).toEqual(['k2', 'k3']);
    expect(((copy.aside as Node).notes as Node[])[0]?._key).toBe('k4');
    expect(r.keys).toEqual({ copy: 'k1' });
    // The original is untouched, and the result still validates (no key used twice).
    expect(section(r.fields)).toEqual(section(page()));
    expect(validateEntryFields(LANDING, r.fields, vctx)).toEqual([]);
  });
});

describe('addressing blocks by key', () => {
  it('refuses a block whose parent has no _key, whose place an undo couldn’t name', () => {
    // Stored before keys were assigned on write, or imported raw: the section has no key.
    const keyless = page();
    delete (body(keyless)[1] as Node)._key;
    const message = 'Block "h2" sits in a block with no _key; save the entry once to key it';
    for (const op of [
      { op: 'remove', ...at, key: 'h2' },
      { op: 'duplicate', ...at, key: 'h2' },
      { op: 'move', ...at, key: 'h2', to: { index: 0 } },
      { op: 'update', ...at, key: 'h2', set: { heading: 'x' } },
    ] as const) {
      expect(refused([op], keyless)[0]?.message).toBe(message);
    }
    // Blocks elsewhere in the field are still patched.
    expect(apply([{ op: 'remove', ...at, key: 'c2' }], keyless).ok).toBe(true);
  });

  it('resolves a ref only in its own field and locale', () => {
    const fields: EntryFields = {
      body: {
        [L]: [{ _type: 'cta', _key: 'a' }],
        de: [{ _type: 'cta', _key: 'x' }],
      },
    };
    const r = applied(
      [
        { op: 'insert', ...at, block: { _type: 'cta', label: 'new' }, ref: 'x' },
        // In de, "x" is that locale's own block, not the en-US insert.
        { op: 'remove', field: 'body', locale: 'de', key: 'x' },
      ],
      fields,
    );
    expect(r.fields.body?.de).toEqual([]);
    expect(r.fields.body?.[L]).toEqual([
      { _type: 'cta', _key: 'a' },
      { _type: 'cta', _key: 'k1', label: 'new' },
    ]);
    // Ref names stay unique across the patch: `keys` answers them by name alone.
    expect(
      refused(
        [
          { op: 'insert', ...at, block: { _type: 'cta' }, ref: 'r' },
          { op: 'insert', field: 'body', locale: 'de', block: { _type: 'cta' }, ref: 'r' },
        ],
        fields,
      )[0],
    ).toMatchObject({ op: 1, message: 'ref "r" is already used in this patch' });
  });

  it('refuses an inserted block keyed like a ref, which a later op would mistake for it', () => {
    const issues = refused([
      { op: 'insert', ...at, block: { _type: 'cta' }, ref: 'x' },
      { op: 'insert', ...at, block: { _type: 'cta', _key: 'x' } },
      { op: 'remove', ...at, key: 'x' },
    ]);
    expect(issues).toEqual([
      {
        op: 1,
        field: 'ops[1]',
        locale: L,
        code: 'key_is_ref',
        message: '_key "x" is a ref in this patch; give the block another key',
      },
    ]);
  });

  it('names, by code and key, the existing block each refusal is about', () => {
    const codeOf = (ops: BlockOp[], fields = page()) => {
      const [issue] = refused(ops, fields);
      return { code: issue?.code, key: issue?.key };
    };
    expect(codeOf([{ op: 'move', ...at, key: 'h1', to: { after: 'h1' } }])).toEqual({
      code: 'placed_by_itself',
      key: 'h1',
    });
    expect(
      codeOf([{ op: 'move', ...at, key: 's1', to: { parent: { key: 's1', slot: 'items' } } }]),
    ).toEqual({ code: 'into_itself', key: 's1' });
    expect(codeOf([{ op: 'insert', ...at, before: 'h2', block: { _type: 'cta' } }])).toEqual({
      code: 'not_in_slot',
      key: 'h2',
    });
    expect(
      codeOf([{ op: 'move', ...at, key: 's1', to: { parent: { key: 'h1', slot: 'items' } } }]),
    ).toEqual({ code: 'not_a_slot', key: 'h1' });
    // A moved block the target slot doesn't admit is named; a new block's own key names no
    // existing block, so it isn't given.
    const twoSections = page();
    (body(twoSections) as Node[]).push({ _type: 'section', _key: 's2', title: 'More' });
    expect(
      codeOf(
        [{ op: 'move', ...at, key: 's2', to: { parent: { key: 's1', slot: 'items' } } }],
        twoSections,
      ),
    ).toEqual({ code: 'type_not_allowed', key: 's2' });
    expect(
      codeOf([
        {
          op: 'insert',
          ...at,
          parent: { key: 's1', slot: 'items' },
          block: { _type: 'section', _key: 'h1' },
        },
      ]),
    ).toEqual({ code: 'type_not_allowed', key: undefined });
    expect(codeOf([{ op: 'update', ...at, key: 'h1', set: { label: 'x' } }])).toEqual({
      code: 'unknown_field',
      key: 'h1',
    });
    // The block that can't be found has no key to name it by.
    expect(codeOf([{ op: 'remove', ...at, key: 'nope' }])).toEqual({
      code: 'unknown_key',
      key: undefined,
    });
  });

  it('refuses an unknown key', () => {
    expect(refused([{ op: 'remove', ...at, key: 'nope' }])[0]?.message).toBe(
      'No block with _key "nope" in body (en-US)',
    );
  });

  it('refuses a key two blocks of the tree hold, at different depths', () => {
    // Validation allows it (keys are unique per array), so a patch must not guess.
    const twice = page();
    (items(twice)[1] as Node)._key = 'h1';
    expect(validateEntryFields(LANDING, twice, vctx)).toEqual([]);
    expect(refused([{ op: 'update', ...at, key: 'h1', set: { heading: 'x' } }], twice)).toEqual([
      {
        op: 0,
        field: 'ops[0]',
        locale: L,
        code: 'ambiguous_key',
        key: 'h1',
        message:
          '_key "h1" is held by 2 blocks in body (en-US), so it can’t say which one: give one ' +
          'of them a new _key with a full save first',
      },
    ]);
    // Other keys of the same tree still work.
    expect(apply([{ op: 'remove', ...at, key: 'c2' }], twice).ok).toBe(true);
  });

  it('keeps keys per locale: the same key in another locale is another block', () => {
    const fields: EntryFields = {
      body: { [L]: [{ _type: 'cta', _key: 'x' }], de: [{ _type: 'cta', _key: 'x' }] },
    };
    const r = applied([{ op: 'update', ...at, key: 'x', set: { label: 'en' } }], fields);
    expect(r.fields.body?.de).toEqual([{ _type: 'cta', _key: 'x' }]);
    expect(r.fields.body?.[L]).toEqual([{ _type: 'cta', _key: 'x', label: 'en' }]);
  });

  it('refuses a field that isn’t a blocks field', () => {
    expect(refused([{ op: 'remove', field: 'title', locale: L, key: 'h1' }])[0]?.message).toBe(
      '"title" is not a blocks field of "landing"',
    );
  });
});

describe('a patch', () => {
  it('is all-or-nothing, naming the op that failed, and never mutates its input', () => {
    const before = page();
    const snapshot = JSON.stringify(before);
    const issues = refused(
      [
        { op: 'remove', ...at, key: 'h1' },
        { op: 'update', ...at, key: 'h1', set: { heading: 'gone' } },
      ],
      before,
    );
    expect(issues).toEqual([
      {
        op: 1,
        field: 'ops[1]',
        locale: L,
        code: 'unknown_key',
        message: 'No block with _key "h1" in body (en-US)',
      },
    ]);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('leaves fields it doesn’t touch as they were', () => {
    const before = page();
    const r = applied([{ op: 'remove', ...at, key: 'c2' }], before);
    expect(r.fields.title).toBe(before.title);
  });
});

describe('inverting a patch', () => {
  const roundTrip = (ops: readonly BlockOp[], before = page()) => {
    const forward = applied(ops, before);
    const inverse = invertBlockPatch(LANDING, before, forward.applied);
    if (!inverse.ok) throw new Error(JSON.stringify(inverse.issues));
    const back = applyBlockPatch(LANDING, forward.fields, inverse.ops, () => {
      throw new Error('an inverse never mints a key');
    });
    if (!back.ok) throw new Error(JSON.stringify(back.issues));
    return { forward, inverse: inverse.ops, back: back.fields };
  };

  it.each<[string, BlockOp[]]>([
    ['an insert', [{ op: 'insert', ...at, after: 'h1', block: { _type: 'cta', label: 'x' } }]],
    ['an update', [{ op: 'update', ...at, key: 'h2', set: { tagline: 'y' }, unset: ['heading'] }]],
    ['a move', [{ op: 'move', ...at, key: 'c1', to: { index: 0 } }]],
    ['a remove', [{ op: 'remove', ...at, key: 's1' }]],
    ['a duplicate', [{ op: 'duplicate', ...at, key: 's1' }]],
    [
      'a patch of every kind, each op on the result of the last',
      [
        { op: 'insert', ...at, block: { _type: 'section', title: 'New' }, ref: 'new' },
        {
          op: 'move',
          ...at,
          key: 'h2',
          to: { parent: { key: 'new', slot: 'items' } },
        },
        { op: 'duplicate', ...at, key: 'h2', ref: 'copy' },
        { op: 'update', ...at, key: 'copy', set: { heading: 'Copy' } },
        { op: 'remove', ...at, key: 'c2' },
        { op: 'move', ...at, key: 'h1', to: { after: 's1' } },
        { op: 'update', ...at, key: 'c1', unset: ['label'] },
      ],
    ],
  ])('round-trips %s', (_name, ops) => {
    const before = page();
    const { forward, back } = roundTrip(ops, before);
    expect(forward.fields).not.toEqual(before);
    expect(back).toEqual(before);
  });

  it('restores a removed block with its own keys', () => {
    const { inverse } = roundTrip([{ op: 'remove', ...at, key: 's1' }]);
    expect(inverse).toEqual([{ op: 'insert', ...at, index: 1, block: section(page()) }]);
  });

  it('refuses ops that would have to mint a key, since what they minted is not in them', () => {
    const r = invertBlockPatch(LANDING, page(), [{ op: 'insert', ...at, block: { _type: 'cta' } }]);
    expect(r.ok ? null : r.issues[0]?.message).toBe(
      'A block here has no _key: invert the applied ops, which carry them all',
    );
  });
});

describe('the block a field issue falls in', () => {
  it('finds the innermost keyed block a validation path names, and the path inside it', () => {
    const fields = page();
    expect(blockAtPath(LANDING, fields, L, 'body[0].heading')).toEqual({
      key: 'h1',
      type: 'hero',
      path: 'heading',
    });
    expect(blockAtPath(LANDING, fields, L, 'body[1].items[1].label')).toEqual({
      key: 'c1',
      type: 'cta',
      path: 'label',
    });
    // Through a plain component, to a block no op can address but an issue can still name.
    expect(blockAtPath(LANDING, fields, L, 'body[1].aside.notes[0].label')).toEqual({
      key: 'n1',
      type: 'cta',
      path: 'label',
    });
    expect(blockAtPath(LANDING, fields, L, 'body[2]')).toEqual({
      key: 'c2',
      type: 'cta',
      path: '',
    });
    expect(blockAtPath(LANDING, fields, L, 'title')).toBeUndefined();
    expect(blockAtPath(LANDING, fields, L, 'body[9].label')).toBeUndefined();
  });
});

describe('the blocks outline', () => {
  it('lists every addressable block with its type, label, path and children', () => {
    expect(outlineBlocks(LANDING, page())).toEqual({
      body: {
        [L]: [
          { key: 'h1', type: 'hero', name: 'Hero', label: 'Welcome', path: 'body[0]' },
          {
            key: 's1',
            type: 'section',
            name: 'Section',
            label: 'Features',
            path: 'body[1]',
            children: {
              items: [
                { key: 'h2', type: 'hero', name: 'Hero', label: 'Fast', path: 'body[1].items[0]' },
                {
                  key: 'c1',
                  type: 'cta',
                  name: 'Call to action',
                  label: 'Try it',
                  path: 'body[1].items[1]',
                },
              ],
            },
          },
          { key: 'c2', type: 'cta', name: 'Call to action', label: 'Sign up', path: 'body[2]' },
        ],
      },
    });
  });

  it('marks a key held twice, and narrows to one field and locale', () => {
    const twice = page();
    (items(twice)[1] as Node)._key = 'h1';
    const outline = outlineBlocks(LANDING, twice, { field: 'body', locale: L });
    expect(outline.body?.[L]?.[0]).toMatchObject({ key: 'h1', ambiguous: true });
    expect(outlineBlocks(LANDING, twice, { locale: 'de' })).toEqual({ body: {} });
  });
});
