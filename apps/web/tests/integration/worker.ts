// The entry the KvBackup tests run: the Workflow as workers/app.ts exports it, and nothing else.
export { KvBackup } from '../../workers/kv-backup';

export default { fetch: () => new Response(null, { status: 404 }) };
