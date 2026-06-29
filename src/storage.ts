import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import { customAlphabet } from "nanoid";
import {
  type CreateProjectionInput,
  type CreateSourceInput,
  type Dataset,
  type DatasetProjection,
  type DatasetQuery,
  DatasetQuerySchema,
  type DatasetQueryResult,
  type DatasetRecord,
  type DatasetSource,
  type DatasetVersion,
  type IngestDatasetInput,
  type JsonObject,
} from "./schemas.js";

export const DATASETS_HOME_ENV = "HASNA_DATASETS_HOME";
export const DATASETS_DB_PATH_ENV = "HASNA_DATASETS_DB_PATH";
export const DATASETS_SCHEMA_VERSION = 1 as const;

const nanoid = customAlphabet(`0123456789${"abcdefghijklmnopqrstuvwxyz"}`, 12);

interface OpenedDb {
  db: Database;
  owned: boolean;
}

interface SourceRow {
  id: string;
  slug: string;
  name: string;
  kind: string;
  uri: string | null;
  path: string | null;
  project_id: string | null;
  config_json: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface DatasetRow {
  id: string;
  slug: string;
  name: string;
  project_id: string | null;
  source_id: string | null;
  status: string;
  classification: string;
  schema_json: string;
  ui_schema_json: string;
  row_count: number;
  byte_size: number | null;
  checksum: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  dataset_id: string;
  version: number;
  source_revision: string | null;
  row_count: number;
  checksum: string | null;
  schema_json: string;
  sample_json: string;
  manifest_json: string;
  created_at: string;
}

interface RecordRow {
  dataset_id: string;
  version_id: string;
  key: string;
  ordinal: number;
  data_json: string;
  hash: string;
  created_at: string;
}

interface ProjectionRow {
  id: string;
  dataset_id: string;
  slug: string;
  name: string;
  kind: string;
  query_json: string;
  render_spec_json: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export function getDatasetsHome(): string {
  return process.env[DATASETS_HOME_ENV] || join(homedir(), ".hasna", "datasets");
}

export function getDatasetsDbPath(): string {
  return process.env[DATASETS_DB_PATH_ENV] || join(getDatasetsHome(), "datasets.db");
}

export function openDatasetsDb(path = getDatasetsDbPath()): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run("PRAGMA foreign_keys=ON");
  db.run("PRAGMA journal_mode=WAL");
  runMigrations(db);
  return db;
}

export function ensureDatasetsStore(db?: Database): { dbPath: string; schemaVersion: number; sources: number; datasets: number; records: number } {
  const opened = openDb(db);
  try {
    return {
      dbPath: getDatasetsDbPath(),
      schemaVersion: DATASETS_SCHEMA_VERSION,
      sources: countTable(opened.db, "dataset_sources"),
      datasets: countTable(opened.db, "datasets"),
      records: countTable(opened.db, "dataset_records"),
    };
  } finally {
    closeIfOwned(opened);
  }
}

export function storageStatus(db?: Database): ReturnType<typeof ensureDatasetsStore> & { home: string; exists: boolean } {
  const status = ensureDatasetsStore(db);
  return { ...status, home: getDatasetsHome(), exists: existsSync(status.dbPath) };
}

export function runMigrations(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS dataset_sources (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      uri TEXT,
      path TEXT,
      project_id TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      project_id TEXT,
      source_id TEXT REFERENCES dataset_sources(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'active',
      classification TEXT NOT NULL DEFAULT 'private',
      schema_json TEXT NOT NULL DEFAULT '{}',
      ui_schema_json TEXT NOT NULL DEFAULT '{}',
      row_count INTEGER NOT NULL DEFAULT 0,
      byte_size INTEGER,
      checksum TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, slug)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS dataset_versions (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      source_revision TEXT,
      row_count INTEGER NOT NULL DEFAULT 0,
      checksum TEXT,
      schema_json TEXT NOT NULL DEFAULT '{}',
      sample_json TEXT NOT NULL DEFAULT '[]',
      manifest_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      UNIQUE(dataset_id, version)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS dataset_records (
      dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
      version_id TEXT NOT NULL REFERENCES dataset_versions(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(dataset_id, version_id, key)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS dataset_projections (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      query_json TEXT NOT NULL DEFAULT '{}',
      render_spec_json TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(dataset_id, slug)
    );
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_datasets_project ON datasets(project_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_records_dataset_ordinal ON dataset_records(dataset_id, ordinal)");
}

export function createSource(input: CreateSourceInput, db?: Database): DatasetSource {
  const opened = openDb(db);
  try {
    const ts = now();
    const id = `dsrc_${nanoid()}`;
    const slug = uniqueSlug("dataset_sources", input.name, opened.db);
    opened.db.run(
      `INSERT INTO dataset_sources (id, slug, name, kind, uri, path, project_id, config_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [id, slug, input.name, input.kind, input.uri ?? null, input.path ?? null, input.projectId ?? null, json(input.config ?? {}), ts, ts],
    );
    return getSource(id, opened.db)!;
  } finally {
    closeIfOwned(opened);
  }
}

export function listSources(projectId?: string | null, db?: Database): DatasetSource[] {
  const opened = openDb(db);
  try {
    const rows = projectId
      ? opened.db.query<SourceRow, [string]>("SELECT * FROM dataset_sources WHERE project_id = ? OR project_id IS NULL ORDER BY updated_at DESC").all(projectId)
      : opened.db.query<SourceRow, []>("SELECT * FROM dataset_sources ORDER BY updated_at DESC").all();
    return rows.map(rowToSource);
  } finally {
    closeIfOwned(opened);
  }
}

export function getSource(ref: string, db?: Database): DatasetSource | null {
  const opened = openDb(db);
  try {
    const row = opened.db.query<SourceRow, [string, string]>("SELECT * FROM dataset_sources WHERE id = ? OR slug = ? LIMIT 1").get(ref, ref);
    return row ? rowToSource(row) : null;
  } finally {
    closeIfOwned(opened);
  }
}

export function ingestDataset(input: IngestDatasetInput, db?: Database): { dataset: Dataset; version: DatasetVersion } {
  const opened = openDb(db);
  try {
    const ts = now();
    const rows = input.rows.map(normalizeRow);
    const schema = input.schema ?? inferJsonSchema(rows);
    const checksum = checksumJson(rows);
    const byteSize = Buffer.byteLength(JSON.stringify(rows));
    const slug = uniqueDatasetSlug(input.projectId ?? null, input.name, opened.db);
    const id = `dset_${nanoid()}`;
    opened.db.run(
      `INSERT INTO datasets (
        id, slug, name, project_id, source_id, status, classification, schema_json, ui_schema_json,
        row_count, byte_size, checksum, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        slug,
        input.name,
        input.projectId ?? null,
        input.sourceId ?? null,
        input.classification ?? "private",
        json(schema),
        json(input.uiSchema ?? {}),
        rows.length,
        byteSize,
        checksum,
        json(input.metadata ?? {}),
        ts,
        ts,
      ],
    );
    const version = createVersion(id, 1, rows, schema, checksum, input.sourceRevision ?? null, opened.db);
    return { dataset: getDataset(id, undefined, opened.db)!, version };
  } finally {
    closeIfOwned(opened);
  }
}

export function listDatasets(projectId?: string | null, db?: Database): Dataset[] {
  const opened = openDb(db);
  try {
    const rows = projectId
      ? opened.db.query<DatasetRow, [string]>("SELECT * FROM datasets WHERE project_id = ? ORDER BY updated_at DESC").all(projectId)
      : opened.db.query<DatasetRow, []>("SELECT * FROM datasets ORDER BY updated_at DESC").all();
    return rows.map(rowToDataset);
  } finally {
    closeIfOwned(opened);
  }
}

export function getDataset(ref: string, projectId?: string | null, db?: Database): Dataset | null {
  const opened = openDb(db);
  try {
    const row = projectId
      ? opened.db.query<DatasetRow, [string, string, string]>("SELECT * FROM datasets WHERE (id = ? OR slug = ?) AND project_id = ? LIMIT 1").get(ref, ref, projectId)
      : opened.db.query<DatasetRow, [string, string]>("SELECT * FROM datasets WHERE id = ? OR slug = ? LIMIT 1").get(ref, ref);
    return row ? rowToDataset(row) : null;
  } finally {
    closeIfOwned(opened);
  }
}

export function getLatestVersion(datasetId: string, db?: Database): DatasetVersion | null {
  const opened = openDb(db);
  try {
    const row = opened.db
      .query<VersionRow, [string]>("SELECT * FROM dataset_versions WHERE dataset_id = ? ORDER BY version DESC LIMIT 1")
      .get(datasetId);
    return row ? rowToVersion(row) : null;
  } finally {
    closeIfOwned(opened);
  }
}

export function previewDataset(ref: string, query: Partial<DatasetQuery> = {}, projectId?: string | null, db?: Database): DatasetQueryResult {
  const opened = openDb(db);
  try {
    const dataset = getDataset(ref, projectId, opened.db);
    if (!dataset) throw new Error(`Dataset not found: ${ref}`);
    const version = getLatestVersion(dataset.id, opened.db);
    const parsed = DatasetQuerySchema.parse(query);
    const allRows = opened.db
      .query<RecordRow, [string]>("SELECT * FROM dataset_records WHERE dataset_id = ? ORDER BY ordinal ASC")
      .all(dataset.id)
      .map(rowToRecord);
    const filtered = applyFilters(allRows.map((row) => row.data), parsed.filters ?? {});
    const sorted = applySort(filtered, parsed.sort ?? []);
    const sliced = sorted.slice(parsed.offset, parsed.offset + parsed.limit);
    const columns = parsed.columns?.length ? parsed.columns : inferColumns(sorted);
    const rows = sliced.map((row) => selectColumns(row, columns));
    return {
      dataset,
      version,
      columns,
      rows,
      total: filtered.length,
      truncated: parsed.offset + parsed.limit < filtered.length,
    };
  } finally {
    closeIfOwned(opened);
  }
}

export function createDatasetProjection(input: CreateProjectionInput, db?: Database): DatasetProjection {
  const opened = openDb(db);
  try {
    const dataset = getDataset(input.dataset, undefined, opened.db);
    if (!dataset) throw new Error(`Dataset not found: ${input.dataset}`);
    const ts = now();
    const id = `dprj_${nanoid()}`;
    const slug = uniqueProjectionSlug(dataset.id, input.name, opened.db);
    opened.db.run(
      `INSERT INTO dataset_projections (id, dataset_id, slug, name, kind, query_json, render_spec_json, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        dataset.id,
        slug,
        input.name,
        input.kind,
        json(input.query ?? {}),
        input.renderSpec ? json(input.renderSpec) : null,
        json(input.metadata ?? {}),
        ts,
        ts,
      ],
    );
    return getProjection(id, opened.db)!;
  } finally {
    closeIfOwned(opened);
  }
}

export function listProjections(datasetRef: string, db?: Database): DatasetProjection[] {
  const opened = openDb(db);
  try {
    const dataset = getDataset(datasetRef, undefined, opened.db);
    if (!dataset) return [];
    return opened.db
      .query<ProjectionRow, [string]>("SELECT * FROM dataset_projections WHERE dataset_id = ? ORDER BY updated_at DESC")
      .all(dataset.id)
      .map(rowToProjection);
  } finally {
    closeIfOwned(opened);
  }
}

export function createDatasetsClient(options: { dbPath?: string } = {}) {
  const db = openDatasetsDb(options.dbPath);
  return {
    db,
    close: () => db.close(),
    ensure: () => ensureDatasetsStore(db),
    createSource: (input: CreateSourceInput) => createSource(input, db),
    listSources: (projectId?: string | null) => listSources(projectId, db),
    getSource: (ref: string) => getSource(ref, db),
    ingestDataset: (input: IngestDatasetInput) => ingestDataset(input, db),
    listDatasets: (projectId?: string | null) => listDatasets(projectId, db),
    getDataset: (ref: string, projectId?: string | null) => getDataset(ref, projectId, db),
    previewDataset: (ref: string, query?: Partial<DatasetQuery>, projectId?: string | null) => previewDataset(ref, query, projectId, db),
    createDatasetProjection: (input: CreateProjectionInput) => createDatasetProjection(input, db),
    listProjections: (datasetRef: string) => listProjections(datasetRef, db),
  };
}

export function inferJsonSchema(rows: JsonObject[]): JsonObject {
  const properties: Record<string, JsonObject> = {};
  const required = new Set<string>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      properties[key] = mergeSchema(properties[key], value);
      if (value !== null && value !== undefined) required.add(key);
    }
  }
  return {
    type: "object",
    properties,
    required: [...required].sort(),
  };
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "dataset";
}

function openDb(db?: Database): OpenedDb {
  return db ? { db, owned: false } : { db: openDatasetsDb(), owned: true };
}

function closeIfOwned(opened: OpenedDb): void {
  if (opened.owned) opened.db.close();
}

function createVersion(datasetId: string, version: number, rows: JsonObject[], schema: JsonObject, checksum: string, sourceRevision: string | null, db: Database): DatasetVersion {
  const ts = now();
  const id = `dver_${nanoid()}`;
  const sample = rows.slice(0, 20);
  db.run(
    `INSERT INTO dataset_versions (id, dataset_id, version, source_revision, row_count, checksum, schema_json, sample_json, manifest_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, datasetId, version, sourceRevision, rows.length, checksum, json(schema), json(sample), json({ sampleSize: sample.length }), ts],
  );
  const insert = db.query("INSERT INTO dataset_records (dataset_id, version_id, key, ordinal, data_json, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    rows.forEach((row, index) => {
      const rowHash = checksumJson(row);
      insert.run(datasetId, id, rowKey(row, index), index, json(row), rowHash, ts);
    });
  })();
  return getLatestVersion(datasetId, db)!;
}

function getProjection(ref: string, db: Database): DatasetProjection | null {
  const row = db.query<ProjectionRow, [string, string]>("SELECT * FROM dataset_projections WHERE id = ? OR slug = ? LIMIT 1").get(ref, ref);
  return row ? rowToProjection(row) : null;
}

function uniqueSlug(table: "dataset_sources", name: string, db: Database): string {
  const base = slugify(name);
  let slug = base;
  let index = 2;
  while (db.query(`SELECT 1 FROM ${table} WHERE slug = ? LIMIT 1`).get(slug)) {
    slug = `${base}-${index}`;
    index += 1;
  }
  return slug;
}

function uniqueDatasetSlug(projectId: string | null, name: string, db: Database): string {
  const base = slugify(name);
  let slug = base;
  let index = 2;
  while (db.query("SELECT 1 FROM datasets WHERE slug = ? AND project_id IS ? LIMIT 1").get(slug, projectId)) {
    slug = `${base}-${index}`;
    index += 1;
  }
  return slug;
}

function uniqueProjectionSlug(datasetId: string, name: string, db: Database): string {
  const base = slugify(name);
  let slug = base;
  let index = 2;
  while (db.query("SELECT 1 FROM dataset_projections WHERE slug = ? AND dataset_id = ? LIMIT 1").get(slug, datasetId)) {
    slug = `${base}-${index}`;
    index += 1;
  }
  return slug;
}

function rowToSource(row: SourceRow): DatasetSource {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind as DatasetSource["kind"],
    uri: row.uri,
    path: row.path,
    projectId: row.project_id,
    config: parseJson(row.config_json, {}),
    status: row.status as DatasetSource["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDataset(row: DatasetRow): Dataset {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    projectId: row.project_id,
    sourceId: row.source_id,
    status: row.status as Dataset["status"],
    classification: row.classification as Dataset["classification"],
    schema: parseJson(row.schema_json, {}),
    uiSchema: parseJson(row.ui_schema_json, {}),
    rowCount: row.row_count,
    byteSize: row.byte_size,
    checksum: row.checksum,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToVersion(row: VersionRow): DatasetVersion {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    version: row.version,
    sourceRevision: row.source_revision,
    rowCount: row.row_count,
    checksum: row.checksum,
    schema: parseJson(row.schema_json, {}),
    sample: parseJson(row.sample_json, []),
    manifest: parseJson(row.manifest_json, {}),
    createdAt: row.created_at,
  };
}

function rowToRecord(row: RecordRow): DatasetRecord {
  return {
    datasetId: row.dataset_id,
    versionId: row.version_id,
    key: row.key,
    ordinal: row.ordinal,
    data: parseJson(row.data_json, {}),
    hash: row.hash,
    createdAt: row.created_at,
  };
}

function rowToProjection(row: ProjectionRow): DatasetProjection {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    slug: row.slug,
    name: row.name,
    kind: row.kind as DatasetProjection["kind"],
    query: parseJson(row.query_json, {}),
    renderSpec: row.render_spec_json ? parseJson(row.render_spec_json, {}) : null,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeRow(value: JsonObject): JsonObject {
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value)) output[stableFieldName(key)] = item;
  return output;
}

function stableFieldName(value: string): string {
  const slug = slugify(value).replace(/-/g, "_");
  return slug || `field_${nanoid()}`;
}

function rowKey(row: JsonObject, index: number): string {
  const candidate = row.id ?? row.key ?? row.slug;
  return typeof candidate === "string" && candidate.trim() ? candidate : `row_${String(index + 1).padStart(6, "0")}`;
}

function checksumJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mergeSchema(existing: JsonObject | undefined, value: unknown): JsonObject {
  const type = jsonType(value);
  if (!existing) return { type };
  if (existing.type === type) return existing;
  const types = new Set<string>(Array.isArray(existing.type) ? existing.type as string[] : [String(existing.type)]);
  types.add(type);
  return { type: [...types].sort() };
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";
  return "string";
}

function applyFilters(rows: JsonObject[], filters: Record<string, unknown>): JsonObject[] {
  const entries = Object.entries(filters);
  if (!entries.length) return rows;
  return rows.filter((row) => entries.every(([key, value]) => row[key] === value));
}

function applySort(rows: JsonObject[], sort: Array<{ column: string; direction: "asc" | "desc" }>): JsonObject[] {
  if (!sort.length) return rows;
  return [...rows].sort((a, b) => {
    for (const item of sort) {
      const left = String(a[item.column] ?? "");
      const right = String(b[item.column] ?? "");
      const compared = left.localeCompare(right, undefined, { numeric: true });
      if (compared !== 0) return item.direction === "desc" ? -compared : compared;
    }
    return 0;
  });
}

function selectColumns(row: JsonObject, columns: string[]): JsonObject {
  return Object.fromEntries(columns.map((column) => [column, row[column] ?? null]));
}

function inferColumns(rows: JsonObject[]): string[] {
  return [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 50);
}

function countTable(db: Database, table: string): number {
  return db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0;
}

function now(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
