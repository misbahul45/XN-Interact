# Dataset collection and export

A terminal-registered manifest declares the origin, path prefix, presentation layout, collection mechanism and fields. Use a documented permission URL when the source is governed by a collection authorization.

```json
{
  "id": "approved-catalog",
  "url": "https://catalog.example.org/listings",
  "path_prefix": "/listings",
  "permission": "owner_controlled",
  "mechanism": "next",
  "authoritative_total": true,
  "fields": [
    {"name": "title", "type": "string", "required": true},
    {"name": "published_at", "type": "date"},
    {"name": "details.summary", "type": "string", "detail": true}
  ]
}
```

Trusted adapters handle one semantic table with unique headers or visible annotated records inside one `main`. Use `data-xn-record` for each record and `data-xn-field` for visible declared values. Detail navigation requires exactly one in-scope `a[data-xn-detail]` and a static or link-based layout. Protected pages supply one visible `data-xn-account` marker.

Choose `static`, `next`, `load_more` or `scroll`. Next links use `rel="next"`. Load-more uses one visible `type="button"` with `data-xn-more`. Virtualized lists may identify a scroll container with `data-xn-scroll`. An explicit `data-xn-end` marks natural termination. Repetition or missing continuation leaves coverage unknown or partial. An optional source-attested `data-xn-total` supplies a denominator for one unfiltered source.

`social_extract_start` takes an idempotent `request_id`, an objective, registered source IDs, entity type, typed fields and `sample`, `bounded` or `all_accessible` coverage. Fields are scalar, array or dotted projections. Use `detail_level: "full"` where enrichment applies. SQLite persists records and field provenance with each page checkpoint. The result includes per-source termination, coverage, field completeness and duplicate observations.

Poll `social_workflows_status`, cancel with `social_workflows_cancel` and read the result with `social_datasets_query`. Query supports projection, equality, sorting and pagination. An incremental request identifies a prior dataset with the same scope and schema. It re-enumerates sources and identifies observed records as new, updated or unchanged. A missing observation proves neither removal nor collection completeness.

`social_datasets_export` writes JSON, JSONL, CSV or SQLite into the owner-only `datasets/` directory and returns a local reference. `datasets delete <dataset-ref>` removes a finished dataset and its gateway-created exports in the owner's terminal.

To ingest an official export already downloaded by the owner, first run `bun run src/cli.ts datasets register <source-manifest>` with `id`, `kind: "owner_export"`, `provider` and typed `fields`. Then run `bun run src/cli.ts datasets ingest <manifest> <file>`. Include the registered `source_id`, `provider`, `entity_type` and selected field names in the import manifest. An optional `identity_field` enables exact-identity deduplication. Inputs can be a flat JSON record array, JSONL, CSV, one HTML table, or one explicitly selected ZIP `archive_member`. ZIP validation checks paths, flags, file type, byte limits and checksums. The selected member is processed without writing archive contents to disk. Import coverage refers to the selected file.
