import type { Dataset, DatasetQueryResult, JsonObject } from "./schemas.js";
import { listDatasets, previewDataset, slugify } from "./storage.js";

export interface DatasetRenderInput {
  dataset: string;
  projectId?: string | null;
  limit?: number;
  redact?: boolean;
}

export interface DatasetCanvasInput {
  projectId: string;
  dataset?: string;
  limit?: number;
}

export interface DatasetJsonRenderSpec extends JsonObject {
  root: string;
  elements: Record<string, JsonObject>;
  metadata: JsonObject;
}

export function buildDatasetRenderSpec(input: DatasetRenderInput): DatasetJsonRenderSpec {
  const preview = previewDataset(input.dataset, { limit: input.limit ?? 20, redact: input.redact ?? true }, input.projectId ?? null);
  return {
    root: "root",
    elements: {
      root: element("Table", {
        title: preview.dataset.name,
        columns: preview.columns,
        rows: preview.rows,
      }),
    },
    metadata: {
      renderer: "json_render",
      package: "@hasna/datasets",
      dataset: datasetMetadata(preview.dataset),
    },
  };
}

export function buildDatasetCanvasSpec(input: DatasetCanvasInput): DatasetJsonRenderSpec {
  const projectId = slugify(input.projectId);
  const datasets = input.dataset
    ? [previewDataset(input.dataset, { limit: input.limit ?? 10 }, projectId).dataset]
    : listDatasets(projectId);
  const nodes = datasets.flatMap((dataset, index) => datasetNodes(dataset, index, input.limit ?? 10));
  const edges = datasets.flatMap((dataset) => [
    { id: `dataset-${dataset.id}-schema`, source: dataset.id, target: `${dataset.id}-schema`, type: "smoothstep" },
    { id: `dataset-${dataset.id}-sample`, source: dataset.id, target: `${dataset.id}-sample`, type: "smoothstep" },
  ]);
  return {
    root: "root",
    elements: {
      root: element("Canvas", {
        title: "Datasets",
        project: { id: projectId, slug: projectId, name: projectId, kind: "project", status: "active" },
        canvas: { id: `datasets:${projectId}`, slug: "datasets", name: "Datasets", status: "active" },
        engine: "react-flow",
        viewport: {},
        nodes,
        edges,
        data: {
          source: "open-datasets",
          privacy: {
            previews_bounded: true,
            raw_records_embedded: false,
          },
        },
        capabilities: {
          infinite_canvas: true,
          multiple_canvases_per_project: true,
          node_renderer: "react-flow",
        },
        ui_contract: {
          connections_optional: true,
          persistent_node_positions: true,
          non_overlapping_nodes: true,
        },
      }),
    },
    metadata: {
      renderer: "react_flow",
      package: "@hasna/datasets",
      projectId,
    },
  };
}

function datasetNodes(dataset: Dataset, index: number, limit: number): JsonObject[] {
  const preview = safePreview(dataset, limit);
  const x = (index % 2) * 460;
  const y = Math.floor(index / 2) * 360;
  return [
    {
      id: dataset.id,
      type: "dataset.summary",
      position: { x, y },
      data: {
        title: dataset.name,
        description: `${dataset.rowCount} rows · ${dataset.classification}`,
        status: dataset.status,
        metrics: [
          { id: "rows", label: "Rows", value: dataset.rowCount },
          { id: "fields", label: "Fields", value: preview.columns.length },
        ],
      },
    },
    {
      id: `${dataset.id}-schema`,
      type: "dataset.schema",
      position: { x: x + 420, y },
      data: {
        title: "Schema",
        description: preview.columns.slice(0, 12).join(", ") || "No fields",
        status: "ready",
      },
    },
    {
      id: `${dataset.id}-sample`,
      type: "dataset.sample",
      position: { x, y: y + 190 },
      data: {
        title: "Sample Rows",
        description: `${preview.rows.length} bounded preview row${preview.rows.length === 1 ? "" : "s"}`,
        status: preview.truncated ? "truncated" : "ready",
        items: preview.rows.slice(0, 5).map((row, rowIndex) => ({
          id: `${dataset.id}-sample-${rowIndex}`,
          title: `Row ${rowIndex + 1} · ${Object.keys(row).slice(0, 6).join(", ") || "No preview columns"}`,
        })),
      },
    },
  ];
}

function safePreview(dataset: Dataset, limit: number): DatasetQueryResult {
  try {
    return previewDataset(dataset.id, { limit });
  } catch {
    return { dataset, version: null, columns: [], rows: [], total: 0, truncated: false };
  }
}

function datasetMetadata(dataset: Dataset): JsonObject {
  return {
    id: dataset.id,
    slug: dataset.slug,
    name: dataset.name,
    projectId: dataset.projectId,
    rowCount: dataset.rowCount,
    classification: dataset.classification,
  };
}

function element(type: string, props: JsonObject, children: string[] = []): JsonObject {
  return { type, props, children };
}
