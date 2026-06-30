# Open Datasets

`@hasna/datasets` is the local dataset registry for Hasna project dashboards.
It stores bounded dataset metadata, versions, records, projections, JSON Render
specs, and a contract-valid `hasna.project_panel.v1` provider output.

The first release is intentionally local-first:

- SQLite store under `~/.hasna/datasets`
- JSON, JSONL, and CSV ingest
- bounded preview/query APIs
- `datasets project-panel --project <slug> --json --contract`
- JSON Render and React Flow-compatible canvas adapters
- MCP stdio tools for listing, previewing, and rendering datasets

Datasets emit `kind: "custom"` in project panels until `open-contracts` adds a
first-class `datasets` integration kind.

## Install

```bash
bun install -g @hasna/datasets
datasets --help
```

## CLI

```bash
datasets init
datasets sources add ./data/contracts.csv --name contracts --kind csv --project swiss-bank-account
datasets ingest contracts --name "Contract Review" --project swiss-bank-account
datasets list --project swiss-bank-account --json
datasets preview contract-review --limit 10 --json
datasets project-panel --project swiss-bank-account --json --contract
datasets render-canvas --project swiss-bank-account --json
```

Private and sensitive datasets are redacted in preview and render output by
default. Use `--unredacted` only for local trusted inspection, with
`OPEN_DATASETS_ALLOW_SENSITIVE_READS=1` set explicitly. MCP unredacted reads
require `OPEN_DATASETS_MCP_ALLOW_SENSITIVE_READS=1`.

## Environment

- `HASNA_DATASETS_HOME`: defaults to `~/.hasna/datasets`
- `HASNA_DATASETS_DB_PATH`: defaults to `$HASNA_DATASETS_HOME/datasets.db`
