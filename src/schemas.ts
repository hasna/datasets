import { z } from "zod";

export const JsonScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type JsonScalar = z.infer<typeof JsonScalarSchema>;
export type JsonValue = JsonScalar | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  JsonScalarSchema,
  z.array(JsonValueSchema),
  z.record(JsonValueSchema),
]));

export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(JsonValueSchema);

export const DatasetSourceKindSchema = z.enum(["csv", "jsonl", "json", "sqlite", "postgres", "manual", "files"]);
export type DatasetSourceKind = z.infer<typeof DatasetSourceKindSchema>;

export const DatasetStatusSchema = z.enum(["draft", "active", "archived"]);
export type DatasetStatus = z.infer<typeof DatasetStatusSchema>;

export const DatasetClassificationSchema = z.enum(["public", "internal", "private", "sensitive"]);
export type DatasetClassification = z.infer<typeof DatasetClassificationSchema>;

export const DatasetProjectionKindSchema = z.enum(["table", "cards", "chart", "timeline", "canvas"]);
export type DatasetProjectionKind = z.infer<typeof DatasetProjectionKindSchema>;

export const DatasetSourceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  kind: DatasetSourceKindSchema,
  uri: z.string().nullable(),
  path: z.string().nullable(),
  projectId: z.string().nullable(),
  config: JsonObjectSchema,
  status: DatasetStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DatasetSource = z.infer<typeof DatasetSourceSchema>;

export const DatasetSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  projectId: z.string().nullable(),
  sourceId: z.string().nullable(),
  status: DatasetStatusSchema,
  classification: DatasetClassificationSchema,
  schema: JsonObjectSchema,
  uiSchema: JsonObjectSchema,
  rowCount: z.number().int().nonnegative(),
  byteSize: z.number().int().nonnegative().nullable(),
  checksum: z.string().nullable(),
  metadata: JsonObjectSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Dataset = z.infer<typeof DatasetSchema>;

export const DatasetVersionSchema = z.object({
  id: z.string(),
  datasetId: z.string(),
  version: z.number().int().positive(),
  sourceRevision: z.string().nullable(),
  rowCount: z.number().int().nonnegative(),
  checksum: z.string().nullable(),
  schema: JsonObjectSchema,
  sample: z.array(JsonObjectSchema),
  manifest: JsonObjectSchema,
  createdAt: z.string(),
});
export type DatasetVersion = z.infer<typeof DatasetVersionSchema>;

export const DatasetRecordSchema = z.object({
  datasetId: z.string(),
  versionId: z.string(),
  key: z.string(),
  ordinal: z.number().int().nonnegative(),
  data: JsonObjectSchema,
  hash: z.string(),
  createdAt: z.string(),
});
export type DatasetRecord = z.infer<typeof DatasetRecordSchema>;

export const DatasetProjectionSchema = z.object({
  id: z.string(),
  datasetId: z.string(),
  slug: z.string(),
  name: z.string(),
  kind: DatasetProjectionKindSchema,
  query: JsonObjectSchema,
  renderSpec: JsonObjectSchema.nullable(),
  metadata: JsonObjectSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DatasetProjection = z.infer<typeof DatasetProjectionSchema>;

export const DatasetQuerySchema = z.object({
  columns: z.array(z.string()).optional(),
  filters: z.record(JsonValueSchema).optional(),
  sort: z.array(z.object({ column: z.string(), direction: z.enum(["asc", "desc"]).default("asc") })).optional(),
  limit: z.number().int().positive().max(500).default(20),
  offset: z.number().int().nonnegative().default(0),
  redact: z.boolean().default(true),
});
export type DatasetQuery = z.infer<typeof DatasetQuerySchema>;

export const DatasetQueryResultSchema = z.object({
  dataset: DatasetSchema,
  version: DatasetVersionSchema.nullable(),
  columns: z.array(z.string()),
  rows: z.array(JsonObjectSchema),
  total: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
});
export type DatasetQueryResult = z.infer<typeof DatasetQueryResultSchema>;

export interface CreateSourceInput {
  name: string;
  kind: DatasetSourceKind;
  uri?: string | null;
  path?: string | null;
  projectId?: string | null;
  config?: JsonObject;
}

export interface IngestDatasetInput {
  name: string;
  projectId?: string | null;
  sourceId?: string | null;
  rows: JsonObject[];
  schema?: JsonObject;
  uiSchema?: JsonObject;
  metadata?: JsonObject;
  classification?: DatasetClassification;
  sourceRevision?: string | null;
}

export interface CreateProjectionInput {
  dataset: string;
  name: string;
  kind: DatasetProjectionKind;
  query?: JsonObject;
  renderSpec?: JsonObject | null;
  metadata?: JsonObject;
}
