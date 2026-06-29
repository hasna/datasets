#!/usr/bin/env bun
import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { Command } from "commander";
import {
  DatasetClassificationSchema,
  DatasetProjectionKindSchema,
  DatasetSourceKindSchema,
  type DatasetClassification,
  type DatasetProjectionKind,
  type DatasetSourceKind,
  type JsonObject,
} from "../schemas.js";
import { createDatasetsProjectPanel } from "../project-panel.js";
import { buildDatasetCanvasSpec, buildDatasetRenderSpec } from "../render.js";
import {
  createDatasetProjection,
  createSource,
  ensureDatasetsStore,
  getDataset,
  getSource,
  ingestDataset,
  inferJsonSchema,
  listDatasets,
  listProjections,
  listSources,
  previewDataset,
  slugify,
  storageStatus,
} from "../storage.js";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printMaybeJson(value: unknown, json: boolean | undefined): void {
  if (json) printJson(value);
  else if (Array.isArray(value)) value.forEach((item) => console.log(summaryLine(item)));
  else console.log(summaryLine(value));
}

function summaryLine(value: unknown): string {
  if (!value || typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  return [record["id"], record["slug"], record["name"], record["status"]].filter(Boolean).join(" ");
}

function parseLimit(value: string | undefined, fallback = 20): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, parsed));
}

function parseKind(value: string): DatasetSourceKind {
  return DatasetSourceKindSchema.parse(value);
}

function parseClassification(value: string | undefined): DatasetClassification {
  return DatasetClassificationSchema.parse(value ?? "private");
}

function parseProjectionKind(value: string): DatasetProjectionKind {
  return DatasetProjectionKindSchema.parse(value);
}

function parseRenderer(value: string | undefined): "json-render" | "react-flow" {
  if (!value) return "json-render";
  if (value === "json-render" || value === "react-flow") return value;
  throw new Error(`Unsupported renderer: ${value}`);
}

function requireUnredactedAllowed(unredacted: boolean | undefined): void {
  if (!unredacted) return;
  const value = process.env.OPEN_DATASETS_ALLOW_SENSITIVE_READS ?? process.env.OPEN_DATASETS_ALLOW_ALL;
  if (value !== "1" && value !== "true" && value !== "yes" && value !== "on") {
    throw new Error("Unredacted previews require OPEN_DATASETS_ALLOW_SENSITIVE_READS=1.");
  }
}

function detectKind(path: string): DatasetSourceKind {
  const ext = extname(path).toLowerCase();
  if (ext === ".csv") return "csv";
  if (ext === ".jsonl" || ext === ".ndjson") return "jsonl";
  if (ext === ".json") return "json";
  if (ext === ".sqlite" || ext === ".db") return "sqlite";
  return "manual";
}

function readRows(path: string, kind: DatasetSourceKind): JsonObject[] {
  const content = readFileSync(path, "utf-8");
  if (kind === "jsonl") {
    return content.split(/\r?\n/).filter(Boolean).map((line) => normalizeObject(JSON.parse(line)));
  }
  if (kind === "json") {
    const parsed = JSON.parse(content);
    const rows = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.rows)
        ? parsed.rows
        : Array.isArray(parsed.records)
          ? parsed.records
          : [parsed];
    return rows.map(normalizeObject);
  }
  if (kind === "csv") return parseCsv(content);
  throw new Error(`Ingest from ${kind} sources is not implemented yet`);
}

function normalizeObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value: value as never };
  return value as JsonObject;
}

function parseCsv(content: string): JsonObject[] {
  const rows = parseCsvRows(content);
  const headers = rows.shift()?.map((header) => slugify(header).replace(/-/g, "_")) ?? [];
  return rows
    .filter((row) => row.some((cell) => cell.trim()))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header || `field_${index + 1}`, sanitizeCsvCell(row[index] ?? "")])));
}

function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    const next = content[index + 1];
    if (quoted && char === "\"" && next === "\"") {
      cell += "\"";
      index += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(cell);
      cell = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function sanitizeCsvCell(value: string): string {
  const trimmed = value.trim();
  return /^[=+\-@]/.test(trimmed) ? `'${trimmed}` : trimmed;
}

export function createProgram(): Command {
  const program = new Command();
  program.name("datasets").description("Local datasets for Hasna project dashboards").version("0.1.3");

  program
    .command("init")
    .description("Initialize the local datasets store")
    .option("--json", "Print JSON", false)
    .action((options: { json?: boolean }) => {
      printMaybeJson(ensureDatasetsStore(), options.json);
    });

  const sources = program.command("sources").description("Manage dataset sources");
  sources
    .command("add")
    .argument("<path-or-uri>")
    .requiredOption("--name <name>", "Source name")
    .option("--kind <kind>", "Source kind")
    .option("--project <slug>", "Project slug")
    .option("--json", "Print JSON", false)
    .action((target: string, options: { name: string; kind?: string; project?: string; json?: boolean }) => {
      const maybePath = resolve(target);
      const isPath = statExists(maybePath);
      const kind = parseKind(options.kind ?? (isPath ? detectKind(maybePath) : "manual"));
      const source = createSource({
        name: options.name,
        kind,
        path: isPath ? maybePath : null,
        uri: isPath ? null : target,
        projectId: options.project ? slugify(options.project) : null,
      });
      printMaybeJson(source, options.json);
    });

  sources
    .command("list")
    .option("--project <slug>", "Project slug")
    .option("--json", "Print JSON", false)
    .action((options: { project?: string; json?: boolean }) => {
      printMaybeJson(listSources(options.project ? slugify(options.project) : undefined), options.json);
    });

  program
    .command("ingest")
    .argument("<source-id-or-path>")
    .requiredOption("--name <dataset>", "Dataset name")
    .option("--project <slug>", "Project slug")
    .option("--schema <file>", "JSON schema file")
    .option("--classification <level>", "public|internal|private|sensitive", "private")
    .option("--json", "Print JSON", false)
    .action((sourceRef: string, options: { name: string; project?: string; schema?: string; classification?: string; json?: boolean }) => {
      const source = getSource(sourceRef);
      const path = source?.path ?? (statExists(resolve(sourceRef)) ? resolve(sourceRef) : null);
      if (!path) throw new Error(`Source path not found: ${sourceRef}`);
      const kind = source?.kind ?? detectKind(path);
      const classification = parseClassification(options.classification);
      const rows = readRows(path, kind);
      const result = ingestDataset({
        name: options.name,
        projectId: options.project ? slugify(options.project) : source?.projectId ?? null,
        sourceId: source?.id ?? null,
        rows,
        schema: options.schema ? JSON.parse(readFileSync(options.schema, "utf-8")) : undefined,
        classification,
        metadata: { sourcePath: path, sourceKind: kind },
      });
      printMaybeJson(result, options.json);
    });

  program
    .command("list")
    .option("--project <slug>", "Project slug")
    .option("--json", "Print JSON", false)
    .action((options: { project?: string; json?: boolean }) => {
      printMaybeJson(listDatasets(options.project ? slugify(options.project) : undefined), options.json);
    });

  program
    .command("show")
    .argument("<dataset>")
    .option("--project <slug>", "Project slug")
    .option("--include-schema", "Include schema in table output", false)
    .option("--json", "Print JSON", false)
    .action((datasetRef: string, options: { project?: string; includeSchema?: boolean; json?: boolean }) => {
      const dataset = getDataset(datasetRef, options.project ? slugify(options.project) : undefined);
      if (!dataset) throw new Error(`Dataset not found: ${datasetRef}`);
      if (options.json) printJson(dataset);
      else {
        console.log(`${dataset.name} ${dataset.status} ${dataset.rowCount} rows`);
        if (options.includeSchema) printJson(dataset.schema);
      }
    });

  program
    .command("preview")
    .argument("<dataset>")
    .option("--project <slug>", "Project slug")
    .option("--limit <n>", "Rows to return", "20")
    .option("--columns <columns>", "Comma-separated columns")
    .option("--unredacted", "Return raw private/sensitive row values; requires OPEN_DATASETS_ALLOW_SENSITIVE_READS=1", false)
    .option("--json", "Print JSON", false)
    .action((datasetRef: string, options: { project?: string; limit?: string; columns?: string; unredacted?: boolean; json?: boolean }) => {
      requireUnredactedAllowed(options.unredacted);
      const result = previewDataset(datasetRef, {
        limit: parseLimit(options.limit),
        columns: options.columns?.split(",").map((item) => item.trim()).filter(Boolean),
        redact: !options.unredacted,
      }, options.project ? slugify(options.project) : undefined);
      printMaybeJson(result, options.json);
    });

  const schema = program.command("schema").description("Infer and validate dataset schemas");
  schema
    .command("infer")
    .argument("<source-or-dataset>")
    .option("--json", "Print JSON", false)
    .action((ref: string, options: { json?: boolean }) => {
      const dataset = getDataset(ref);
      if (dataset) return printMaybeJson(dataset.schema, options.json);
      const source = getSource(ref);
      const path = source?.path ?? (statExists(resolve(ref)) ? resolve(ref) : null);
      if (!path) throw new Error(`Source or dataset not found: ${ref}`);
      const rows = readRows(path, source?.kind ?? detectKind(path));
      printMaybeJson(inferJsonSchema(rows), options.json);
    });

  const projections = program.command("projections").description("Manage dataset projections");
  projections
    .command("create")
    .argument("<dataset>")
    .requiredOption("--name <name>", "Projection name")
    .requiredOption("--kind <kind>", "table|cards|chart|timeline|canvas")
    .option("--query-json <json>", "Projection query JSON")
    .option("--spec-json <json>", "Render spec JSON")
    .option("--json", "Print JSON", false)
    .action((datasetRef: string, options: { name: string; kind: string; queryJson?: string; specJson?: string; json?: boolean }) => {
      const projection = createDatasetProjection({
        dataset: datasetRef,
        name: options.name,
        kind: parseProjectionKind(options.kind),
        query: options.queryJson ? JSON.parse(options.queryJson) : {},
        renderSpec: options.specJson ? JSON.parse(options.specJson) : null,
      });
      printMaybeJson(projection, options.json);
    });

  projections
    .command("list")
    .argument("<dataset>")
    .option("--json", "Print JSON", false)
    .action((datasetRef: string, options: { json?: boolean }) => {
      printMaybeJson(listProjections(datasetRef), options.json);
    });

  program
    .command("render")
    .argument("<dataset>")
    .option("--project <slug>", "Project slug")
    .option("--limit <n>", "Preview rows", "20")
    .option("--renderer <name>", "json-render|react-flow", "json-render")
    .option("--unredacted", "Return raw private/sensitive row values in JSON Render table specs; requires OPEN_DATASETS_ALLOW_SENSITIVE_READS=1", false)
    .option("--json", "Print JSON", false)
    .action((datasetRef: string, options: { project?: string; limit?: string; renderer?: string; unredacted?: boolean; json?: boolean }) => {
      requireUnredactedAllowed(options.unredacted);
      const renderer = parseRenderer(options.renderer);
      const limit = parseLimit(options.limit);
      const spec = renderer === "react-flow"
        ? buildDatasetCanvasSpec({ projectId: options.project ? slugify(options.project) : "project", dataset: datasetRef, limit })
        : buildDatasetRenderSpec({ dataset: datasetRef, projectId: options.project ? slugify(options.project) : null, limit, redact: !options.unredacted });
      printJson(spec);
    });

  program
    .command("render-canvas")
    .option("--project <slug>", "Project slug", "project")
    .option("--dataset <dataset>", "Dataset to render")
    .option("--limit <n>", "Preview rows", "10")
    .option("--json", "Print JSON", false)
    .action((options: { project: string; dataset?: string; limit?: string; json?: boolean }) => {
      const spec = buildDatasetCanvasSpec({ projectId: options.project, dataset: options.dataset, limit: parseLimit(options.limit, 10) });
      printJson(spec);
    });

  program
    .command("project-panel")
    .requiredOption("--project <slug>", "Project slug")
    .option("--limit <n>", "Items to include", "20")
    .option("--json", "Print JSON", false)
    .option("--contract", "Alias for --json", false)
    .action((options: { project: string; limit?: string; json?: boolean; contract?: boolean }) => {
      const panel = createDatasetsProjectPanel(options.project, { limit: parseLimit(options.limit) });
      printMaybeJson(panel, options.json || options.contract);
    });

  const storage = program.command("storage").description("Inspect dataset storage");
  storage
    .command("status")
    .option("--json", "Print JSON", false)
    .action((options: { json?: boolean }) => printMaybeJson(storageStatus(), options.json));
  storage
    .command("doctor")
    .option("--json", "Print JSON", false)
    .action((options: { json?: boolean }) => printMaybeJson({ ok: true, storage: storageStatus() }, options.json));

  return program;
}

function statExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  await createProgram().parseAsync(process.argv);
}
