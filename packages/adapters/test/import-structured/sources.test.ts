import { describe, expect, it } from 'vitest';
import { createCsvImportSource, createJsonImportSource } from '../../src/import-structured/index';

const csv = createCsvImportSource();
const json = createJsonImportSource();

describe('reading CSV', () => {
  it('reads a header row and one record per line', async () => {
    const result = await csv.read('title,views\nHello,3\nWorld,4\n');
    expect(result.fields).toEqual(['title', 'views']);
    expect(result.records.map((r) => r.values)).toEqual([
      { title: 'Hello', views: '3' },
      { title: 'World', views: '4' },
    ]);
  });

  it('keeps a comma that is inside quotes', async () => {
    const result = await csv.read('title,tags\n"Hello, world","a,b"\n');
    expect(result.records[0]?.values).toEqual({ title: 'Hello, world', tags: 'a,b' });
  });

  it('keeps a newline that is inside quotes', async () => {
    // The single most common way a naive CSV reader loses half a file.
    const result = await csv.read('title,body\n"A","line one\nline two"\n');
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.values.body).toBe('line one\nline two');
  });

  it('unescapes a doubled quote', async () => {
    const result = await csv.read('title\n"She said ""hi"""\n');
    expect(result.records[0]?.values.title).toBe('She said "hi"');
  });

  it('does not import a carriage return with every value', async () => {
    const result = await csv.read('title,views\r\nHello,3\r\n');
    expect(result.records[0]?.values).toEqual({ title: 'Hello', views: '3' });
  });

  it('ignores the empty line a file ends with', async () => {
    expect((await csv.read('title\nHello\n')).records).toHaveLength(1);
  });

  it('names an unnamed column instead of dropping it', async () => {
    const result = await csv.read('title,\nHello,x\n');
    // A column that cannot be named cannot be mapped, and its data is gone.
    expect(result.fields).toEqual(['title', 'column2']);
    expect(result.warnings[0]).toMatch(/no header/i);
  });

  it('says when a row is the wrong width rather than shifting values', async () => {
    const result = await csv.read('a,b,c\n1,2\n');
    expect(result.warnings[0]).toMatch(/2 value\(s\) for 3 column\(s\)/);
    expect(result.records[0]?.values).toEqual({ a: '1', b: '2', c: '' });
  });

  it('refuses a file with no header', async () => {
    await expect(csv.read('')).rejects.toThrow(/no header/i);
  });
});

describe('reading JSON', () => {
  it('reads an array of objects', async () => {
    const result = await json.read('[{"title":"A"},{"title":"B"}]');
    expect(result.fields).toEqual(['title']);
    expect(result.records).toHaveLength(2);
  });

  it('unwraps the shapes an export API actually uses', async () => {
    for (const key of ['items', 'records', 'data', 'results']) {
      const result = await json.read(`{"${key}":[{"title":"A"}]}`);
      expect(result.records).toHaveLength(1);
    }
  });

  it('collects field names across rows, not just the first', async () => {
    // A column blank in row one is still a column.
    const result = await json.read('[{"title":"A"},{"title":"B","subtitle":"S"}]');
    expect(result.fields).toEqual(['title', 'subtitle']);
  });

  it('flattens one level so wrapped values can be named', async () => {
    const result = await json.read('[{"title":{"rendered":"Hello"}}]');
    expect(result.fields).toEqual(['title.rendered']);
    expect(result.records[0]?.values['title.rendered']).toBe('Hello');
  });

  it('leaves a list whole — it is a value, not a set of columns', async () => {
    const result = await json.read('[{"tags":["a","b"]}]');
    expect(result.records[0]?.values.tags).toEqual(['a', 'b']);
  });

  it('names a row it could not read instead of silently skipping it', async () => {
    const result = await json.read('[{"title":"A"},"nope"]');
    expect(result.records).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/Row 2/);
  });

  it('says what is wrong with malformed JSON', async () => {
    await expect(json.read('{oh no')).rejects.toThrow(/not valid json/i);
  });

  it('refuses a shape it cannot find rows in', async () => {
    await expect(json.read('{"total":3}')).rejects.toThrow(/expected a json array/i);
  });
});

describe('identity', () => {
  it('uses the field it was told to use', async () => {
    const result = await csv.read('sku,title\nA-1,Hello\n', { identityField: 'sku' });
    expect(result.records[0]?.externalId).toBe('A-1');
  });

  it('finds a conventional id without being told', async () => {
    expect((await json.read('[{"id":42,"title":"A"}]')).records[0]?.externalId).toBe('42');
  });

  it('falls back to position, visibly', async () => {
    // "row-1" reads as a fallback at a glance; "1" would read as real data.
    expect((await json.read('[{"title":"A"}]')).records[0]?.externalId).toBe('row-1');
  });

  it('falls back when the identity field is empty on a row', async () => {
    const result = await csv.read('id,title\n,Hello\n', { identityField: 'id' });
    expect(result.records[0]?.externalId).toBe('row-1');
  });
});
