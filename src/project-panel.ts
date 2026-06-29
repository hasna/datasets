import {
  parseContract,
  SCHEMA_IDS,
  type ProjectPanel,
  type ProjectPanelInput,
} from "@hasna/contracts";
import { getLatestVersion, listDatasets, listSources, previewDataset, slugify } from "./storage.js";
import type { Dataset, DatasetSource, JsonObject } from "./schemas.js";

export interface DatasetsProjectPanelOptions {
  limit?: number;
}

const SOURCE_PACKAGE = "@hasna/datasets";

export function createDatasetsProjectPanel(projectId: string, options: DatasetsProjectPanelOptions = {}): ProjectPanel {
  const limit = clampLimit(options.limit);
  const generatedAt = new Date().toISOString();
  const slug = slugify(projectId);
  const datasets = listDatasets(slug);
  const sources = listSources(slug);
  const rows = datasets.reduce((sum, dataset) => sum + dataset.rowCount, 0);
  const active = datasets.filter((dataset) => dataset.status === "active");
  const classifications = new Set(datasets.map((dataset) => dataset.classification));
  const latestDataset = datasets[0];
  const latestVersion = latestDataset ? getLatestVersion(latestDataset.id) : null;
  const state = datasets.length === 0 ? "empty" : "ready";

  const draft: ProjectPanelInput = {
    schema: SCHEMA_IDS.projectPanel,
    id: `datasets_panel_${slug}`,
    createdAt: generatedAt,
    projectId: slug,
    provider: {
      kind: "custom",
      id: `datasets_${slug}`,
      name: "Datasets",
      sourcePackage: SOURCE_PACKAGE,
      externalId: slug,
    },
    kind: "custom",
    title: "Datasets",
    summary: datasets.length === 0
      ? "No project datasets are registered yet."
      : `${datasets.length} dataset${datasets.length === 1 ? "" : "s"} with ${rows} row${rows === 1 ? "" : "s"}.`,
    state,
    generatedAt,
    freshness: latestVersion ? "fresh" : "unknown",
    metrics: [
      { id: "datasets", label: "Datasets", value: datasets.length, status: datasets.length ? "good" : "unknown" },
      { id: "active_datasets", label: "Active", value: active.length, status: active.length ? "good" : "unknown" },
      { id: "rows", label: "Rows", value: rows, status: rows ? "good" : "unknown" },
      { id: "sources", label: "Sources", value: sources.length, status: sources.length ? "good" : "unknown" },
      { id: "classifications", label: "Classifications", value: classifications.size, status: classifications.size ? "good" : "unknown" },
    ],
    items: datasets.slice(0, limit).map(datasetItem),
    warnings: datasets.some((dataset) => dataset.classification === "sensitive")
      ? ["One or more datasets are marked sensitive; previews must stay redacted and bounded."]
      : [],
    resourceRefs: [
      {
        kind: "project",
        id: slug,
        name: slug,
        uri: `project://${slug}`,
        externalId: slug,
        sourcePackage: SOURCE_PACKAGE,
      },
      ...datasets.slice(0, limit).map(datasetResource),
      ...sources.slice(0, limit).map(sourceResource),
    ],
    renderFragment: {
      renderer: "json_render",
      title: "Datasets",
      spec: {
        component: "project.datasets.summary",
        itemLimit: limit,
        datasets: datasets.map((dataset) => ({
          id: dataset.id,
          slug: dataset.slug,
          name: dataset.name,
          rows: dataset.rowCount,
          classification: dataset.classification,
        })),
      },
    },
  };

  return parseContract(SCHEMA_IDS.projectPanel, draft);
}

function datasetItem(dataset: Dataset): NonNullable<ProjectPanelInput["items"]>[number] {
  const preview = safePreview(dataset);
  const properties = (dataset.schema.properties as JsonObject | undefined) ?? {};
  return {
    id: dataset.id,
    title: dataset.name,
    summary: `${dataset.rowCount} row${dataset.rowCount === 1 ? "" : "s"} · ${Object.keys(properties).length} fields`,
    status: dataset.status,
    priority: dataset.classification === "sensitive" ? "high" : "medium",
    timestamp: dataset.updatedAt,
    resourceRefs: [datasetResource(dataset)],
    metadata: {
      slug: dataset.slug,
      classification: dataset.classification,
      previewColumns: preview.columns,
    },
  };
}

function safePreview(dataset: Dataset): { columns: string[] } {
  try {
    return { columns: previewDataset(dataset.id, { limit: 1 }).columns.slice(0, 8) };
  } catch {
    return { columns: [] };
  }
}

function datasetResource(dataset: Dataset) {
  return {
    kind: "artifact" as const,
    id: dataset.id,
    name: dataset.name,
    uri: `artifact://datasets/${dataset.id}`,
    externalId: dataset.id,
    sourcePackage: SOURCE_PACKAGE,
    tags: ["dataset", dataset.status, dataset.classification],
  };
}

function sourceResource(source: DatasetSource) {
  return {
    kind: "artifact" as const,
    id: source.id,
    name: source.name,
    uri: `artifact://datasets/sources/${source.id}`,
    externalId: source.id,
    sourcePackage: SOURCE_PACKAGE,
    tags: ["dataset-source", source.kind, source.status],
  };
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? 0)) return 20;
  return Math.max(1, Math.min(100, Math.trunc(limit ?? 20)));
}
