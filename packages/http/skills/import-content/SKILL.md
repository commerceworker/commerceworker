---

name: import-content
description: Bring content from an external file (CSV, JSON and the other formats import_sources lists) into CommerceWorker entries safely — map fields, dry-run the import, run it, then publish. Use for migrations and bulk loads.
---

# Import content

An import maps records from a source file onto one content type. It is a migration, so check
what it will do before running it.

## Steps

1. `import_sources` — the formats this deployment reads. Pass one as `source`.
2. **Find the source columns.** Run `import_analyze` with an empty `fields` mapping: every source
   field comes back in `unmappedSourceFields`.
3. **Map** `fields` as `{ targetFieldApiId: sourceFieldName }` (target first). Set `identityField`
   to the target field holding the source's stable id. Without it, every re-run creates every
   record again.
4. **Dry-run** with `import_analyze` and the full mapping. It is the same computation as the
   import, without the commit. Fix the mapping until:
   - `missingRequiredFields` and `unknownTargetFields` are empty (both block the run);
   - `unmappedSourceFields` lists only data you mean to drop;
   - the `issues` sample shows no systematic failure.
5. **Run** `import_execute` with the same arguments. `conflicts` decides what happens to records
   already imported: `skip` (the default), `update`, or `fail`.
6. **Publish.** Imported entries arrive as drafts. Publish them with `bulk_job_start`, which you can
   resume, cancel and report on (`bulk_job_status`, `bulk_job_report`).

## A whole space export

A JSON space export (`contentTypes`, `entries`, `assets`, `locales`, `tags`) brings its own
content model, so there is nothing to map:

1. `space_export_analyze` with `payload` (the file's text) into an environment with no content
   types. Read `problems` (they block), `unmappedFields`, `unmappedValidations`, `missingLinks`
   and `invalidEntries`. If `locales.toAdd` is not empty, a caller with `space:admin` passes
   `addLocales: true`.
2. `space_export_import` with the same arguments. Follow `job` with `bulk_job_status`, then
   `publishJobId` (it starts only after `job` completes with no failures; `bulk_job_report` names
   any asset file that could not be copied).

## Limits

- A record that fails validation is skipped and reported; the rest of the run continues.
- Trashed entries are never matched as conflicts, so an import cannot bring back deleted content.
- One synchronous run accepts at most 10,000 records. For more, split the file or follow the
  durable path in the `api-reference` docs (`docs_read` → "Bigger than one request").
