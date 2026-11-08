// Live RAG smoke: model + author + publish via MCP, wait for the worker to embed
// into Vectorize, then semantic-search.
import { setTimeout as sleep } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = new URL(process.env.MCP_URL ?? 'http://localhost:5173/mcp');
const token = process.env.MCP_TOKEN ?? 'dev-mcp-token';

const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'search-smoke', version: '0.0.0' });
await client.connect(transport);

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${res.content[0].text}`);
  return JSON.parse(res.content[0].text);
};

await call('model_create_content_type', {
  apiId: 'doc',
  name: 'Doc',
  displayField: 'title',
  fields: [
    {
      apiId: 'title',
      name: 'Title',
      type: 'Symbol',
      localized: false,
      required: true,
      position: 0,
    },
    { apiId: 'body', name: 'Body', type: 'Text', localized: false, required: false, position: 1 },
  ],
});
await call('model_publish_content_type', { apiId: 'doc' });

const docs = [
  {
    title: 'SQLite indexing',
    body: 'SQLite B-tree and covering indexes speed up queries on large relational tables.',
  },
  {
    title: 'Espresso brewing',
    body: 'Pulling a good espresso shot depends on grind size, pressure, and water temperature.',
  },
];
for (const d of docs) {
  const e = await call('entries_create', {
    contentType: 'doc',
    fields: { title: { 'en-US': d.title }, body: { 'en-US': d.body } },
  });
  await call('entries_publish', { id: e.entry.id });
}

// Give the worker a moment to relay + embed.
// NOTE: the dev embedder (LocalEmbeddingsProvider) is lexical, so the query
// shares vocabulary with the target doc. A real model (Workers AI embeddings) matches
// semantically and wouldn't need shared tokens.
const query = 'relational database indexes and queries';
// Poll for the target doc itself, not for any hit: a seeded space always has some (noise), and the
// new docs queue behind whatever the engine is still relaying (a fresh seed is ~450 events).
const relevant = (hs) => hs[0]?.snippet.includes('SQLite');
let hits = [];
for (let i = 0; i < 60 && !relevant(hits); i++) {
  await sleep(1000);
  hits = await call('content_semantic_search', { query, topK: 5 });
}
console.log(`search "${query}" ->`);
for (const h of hits) console.log(`  ${h.score.toFixed(3)}  ${h.snippet.slice(0, 60)}`);

await client.close();
await transport.close();
console.log(relevant(hits) ? 'OK: relevant result ranked first' : 'NO RELEVANT RESULT');
if (!relevant(hits)) process.exitCode = 1;
