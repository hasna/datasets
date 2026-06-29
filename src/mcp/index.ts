#!/usr/bin/env bun
import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createDatasetsProjectPanel } from "../project-panel.js";
import { buildDatasetCanvasSpec, buildDatasetRenderSpec } from "../render.js";
import {
  DatasetClassificationSchema,
  DatasetProjectionKindSchema,
  DatasetSourceKindSchema,
  type DatasetSourceKind,
  type JsonObject,
} from "../schemas.js";
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

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

type ToolHandler = (params: any) => unknown | Promise<unknown>;
type McpCapability = "mutations" | "imports";

const MCP_TOOL_CAPABILITIES: Record<string, McpCapability[]> = {
  datasets_sources_add: ["mutations"],
  datasets_ingest: ["mutations", "imports"],
  datasets_projections_create: ["mutations"],
};

export function buildServer(): McpServer {
  const server = new McpServer({
    name: "datasets",
    version: pkg.version,
  });

  registerTool(server, "datasets_storage_status", "Inspect the local open-datasets store", {}, async () => storageStatus());

  registerTool(server, "datasets_sources_list", "List registered dataset sources", {
    project: z.string().optional().describe("Optional project slug"),
  }, async ({ project }) => listSources(project ? slugify(project) : undefined));

  registerTool(server, "datasets_sources_add", "Register a dataset source", {
    target: z.string().describe("Local path or external URI"),
    name: z.string().describe("Human-readable source name"),
    kind: DatasetSourceKindSchema.optional().describe("Source kind; inferred for local paths when omitted"),
    project: z.string().optional().describe("Optional project slug"),
    config: z.record(z.unknown()).optional().describe("Connector/source config; do not include secrets"),
  }, async ({ target, name, kind, project, config }) => {
    const maybePath = resolve(target);
    const isPath = statExists(maybePath);
    return createSource({
      name,
      kind: kind ?? (isPath ? detectKind(maybePath) : "manual"),
      path: isPath ? maybePath : null,
      uri: isPath ? null : target,
      projectId: project ? slugify(project) : null,
      config: normalizeObject(config ?? {}),
    });
  });

  registerTool(server, "datasets_list", "List datasets", {
    project: z.string().optional().describe("Optional project slug"),
  }, async ({ project }) => listDatasets(project ? slugify(project) : undefined));

  registerTool(server, "datasets_show", "Show a dataset by id or slug", {
    dataset: z.string().describe("Dataset id or slug"),
    project: z.string().optional().describe("Optional project slug"),
  }, async ({ dataset, project }) => {
    const found = getDataset(dataset, project ? slugify(project) : undefined);
    if (!found) throw new Error(`Dataset not found: ${dataset}`);
    return found;
  });

  registerTool(server, "datasets_preview", "Preview bounded rows from a dataset", {
    dataset: z.string().describe("Dataset id or slug"),
    project: z.string().optional().describe("Optional project slug"),
    limit: z.number().int().positive().max(500).optional().default(20),
    columns: z.array(z.string()).optional().describe("Optional selected columns"),
  }, async ({ dataset, project, limit, columns }) => {
    return previewDataset(dataset, { limit, columns }, project ? slugify(project) : undefined);
  });

  registerTool(server, "datasets_ingest", "Ingest rows from a registered source or local CSV/JSON/JSONL path", {
    source: z.string().describe("Source id/slug or local file path"),
    name: z.string().describe("Dataset name"),
    project: z.string().optional().describe("Optional project slug"),
    classification: DatasetClassificationSchema.optional().default("private"),
  }, async ({ source: sourceRef, name, project, classification }) => {
    const source = getSource(sourceRef);
    const path = source?.path ?? (statExists(resolve(sourceRef)) ? resolve(sourceRef) : null);
    if (!path) throw new Error(`Source path not found: ${sourceRef}`);
    const kind = source?.kind ?? detectKind(path);
    const rows = readRows(path, kind);
    return ingestDataset({
      name,
      projectId: project ? slugify(project) : source?.projectId ?? null,
      sourceId: source?.id ?? null,
      rows,
      classification,
      metadata: { sourcePath: path, sourceKind: kind },
    });
  });

  registerTool(server, "datasets_schema_infer", "Infer a JSON schema from a dataset, source, or file path", {
    ref: z.string().describe("Dataset id/slug, source id/slug, or local file path"),
  }, async ({ ref }) => {
    const dataset = getDataset(ref);
    if (dataset) return dataset.schema;
    const source = getSource(ref);
    const path = source?.path ?? (statExists(resolve(ref)) ? resolve(ref) : null);
    if (!path) throw new Error(`Source or dataset not found: ${ref}`);
    return inferJsonSchema(readRows(path, source?.kind ?? detectKind(path)));
  });

  registerTool(server, "datasets_projections_create", "Create a saved dataset projection", {
    dataset: z.string().describe("Dataset id or slug"),
    name: z.string().describe("Projection name"),
    kind: DatasetProjectionKindSchema,
    query: z.record(z.unknown()).optional(),
    renderSpec: z.record(z.unknown()).nullable().optional(),
  }, async ({ dataset, name, kind, query, renderSpec }) => {
    return createDatasetProjection({
      dataset,
      name,
      kind,
      query: normalizeObject(query ?? {}),
      renderSpec: renderSpec === undefined ? null : normalizeObject(renderSpec ?? {}),
    });
  });

  registerTool(server, "datasets_projections_list", "List projections for a dataset", {
    dataset: z.string().describe("Dataset id or slug"),
  }, async ({ dataset }) => listProjections(dataset));

  registerTool(server, "datasets_render", "Build a JSON Render table spec for a dataset preview", {
    dataset: z.string().describe("Dataset id or slug"),
    project: z.string().optional().describe("Optional project slug"),
    limit: z.number().int().positive().max(500).optional().default(20),
  }, async ({ dataset, project, limit }) => buildDatasetRenderSpec({ dataset, projectId: project ? slugify(project) : null, limit }));

  registerTool(server, "datasets_render_canvas", "Build a React Flow canvas spec for project datasets", {
    project: z.string().describe("Project slug"),
    dataset: z.string().optional().describe("Optional dataset id or slug"),
    limit: z.number().int().positive().max(500).optional().default(10),
  }, async ({ project, dataset, limit }) => buildDatasetCanvasSpec({ projectId: project, dataset, limit }));

  registerTool(server, "datasets_project_panel", "Build an open-projects project panel for datasets", {
    project: z.string().describe("Project slug"),
    limit: z.number().int().positive().max(100).optional().default(20),
  }, async ({ project, limit }) => createDatasetsProjectPanel(project, { limit }));

  registerTool(server, "datasets_init", "Initialize the local datasets store", {}, async () => ensureDatasetsStore());

  return server;
}

function registerTool(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny>,
  handler: ToolHandler,
): void {
  (server.tool as any)(name, description, inputSchema, async (params: any) => {
    const denied = requireMcpToolCapabilities(name);
    if (denied) return denied;
    try {
      const result = await handler(params);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
}

function requireMcpToolCapabilities(toolName: string) {
  const missing = (MCP_TOOL_CAPABILITIES[toolName] ?? []).filter((capability) => !mcpCapabilityEnabled(capability));
  if (!missing.length) return null;
  return {
    content: [{
      type: "text" as const,
      text: [
        `MCP tool '${toolName}' requires explicit capability: ${missing.join(", ")}.`,
        `Start datasets-mcp with ${missing.map(capabilityEnvName).join(" and ")} set to 1, or OPEN_DATASETS_MCP_ALLOW_ALL=1.`,
      ].join(" "),
    }],
    isError: true,
  };
}

function mcpCapabilityEnabled(capability: McpCapability): boolean {
  return truthyEnv(process.env.OPEN_DATASETS_MCP_ALLOW_ALL)
    || truthyEnv(process.env.OPEN_DATASETS_ALLOW_ALL)
    || truthyEnv(process.env[`OPEN_DATASETS_ALLOW_${capability.toUpperCase()}`])
    || truthyEnv(process.env[capabilityEnvName(capability)]);
}

function capabilityEnvName(capability: McpCapability): string {
  return `OPEN_DATASETS_MCP_ALLOW_${capability.toUpperCase()}`;
}

function truthyEnv(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function readRows(path: string, kind: DatasetSourceKind): JsonObject[] {
  const content = readFileSync(path, "utf-8");
  if (kind === "jsonl") {
    return content.split(/\r?\n/).filter(Boolean).map((line) => normalizeObject(JSON.parse(line)));
  }
  if (kind === "json") {
    const parsed = JSON.parse(content);
    const rows = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { rows?: unknown }).rows) ? (parsed as { rows: unknown[] }).rows : [parsed];
    return rows.map(normalizeObject);
  }
  if (kind === "csv") return parseCsv(content);
  throw new Error(`Ingest from ${kind} sources is not implemented yet`);
}

function normalizeObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function detectKind(path: string): DatasetSourceKind {
  const ext = extname(path).toLowerCase();
  if (ext === ".csv") return "csv";
  if (ext === ".jsonl" || ext === ".ndjson") return "jsonl";
  if (ext === ".json") return "json";
  if (ext === ".sqlite" || ext === ".db") return "sqlite";
  return "manual";
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

function statExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function printHelp(): void {
  console.log(`Usage: datasets-mcp [options]

Runs the open-datasets MCP server over stdio.

Options:
  --stdio       Run over stdio (default)
  -h, --help   Show this help text`);
}

async function main(): Promise<void> {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    printHelp();
    return;
  }

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
