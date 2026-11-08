// Live MCP smoke test: connects with the official client over streamable HTTP,
// lists tools, calls a read tool, and checks bearer auth.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = new URL(process.env.MCP_URL ?? 'http://localhost:5173/mcp');
const token = process.env.MCP_TOKEN ?? 'dev-mcp-token';

async function connect(bearer) {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: 'smoke', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

// 1. Auth: a bad token must be rejected.
let authRejected = false;
try {
  const bad = await connect('wrong-token');
  await bad.client.close();
} catch {
  authRejected = true;
}
console.log('auth rejects bad token:', authRejected);

// 2. Connect properly, list tools, run the full agentic write loop.
const { client, transport } = await connect(token);
const { tools } = await client.listTools();
console.log(
  'tools:',
  tools
    .map((t) => t.name)
    .sort()
    .join(', '),
);

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} failed: ${res.content[0].text}`);
  return JSON.parse(res.content[0].text);
};

// model -> publish type -> author -> publish entry -> read back via query
await call('model_create_content_type', {
  apiId: 'note',
  name: 'Note',
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
  ],
});
await call('model_publish_content_type', { apiId: 'note' });
const created = await call('entries_create', {
  contentType: 'note',
  fields: { title: { 'en-US': 'Authored by an agent' } },
});
console.log('created entry:', created.entry.id, 'status:', created.entry.status);
const published = await call('entries_publish', { id: created.entry.id });
console.log('published:', published.status, 'v', published.publishedVersion);
const got = await call('entries_get', { id: created.entry.id });
console.log('entries_get title:', got.fields.title['en-US']);
const types = await call('model_list_content_types', {});
console.log('content types now:', types.map((t) => t.apiId).join(', '));

await client.close();
await transport.close();
console.log('OK');
