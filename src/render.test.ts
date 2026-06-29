import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDatasetCanvasSpec, buildDatasetRenderSpec } from "./render.js";
import type { JsonObject } from "./schemas.js";
import { DATASETS_DB_PATH_ENV, DATASETS_HOME_ENV, ingestDataset } from "./storage.js";

const ENV_KEYS = [DATASETS_HOME_ENV, DATASETS_DB_PATH_ENV] as const;
const savedEnv = new Map<string, string | undefined>();
let testDir: string | undefined;

for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "datasets-render-"));
  process.env[DATASETS_HOME_ENV] = testDir;
  process.env[DATASETS_DB_PATH_ENV] = join(testDir, "datasets.db");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = undefined;
});

describe("dataset render adapters", () => {
  test("builds a JSON Render table spec", () => {
    const dataset = ingestDataset({
      name: "Bank shortlist",
      projectId: "swiss-bank-account",
      rows: [{ bank: "Mirabaud", status: "research" }],
    }).dataset;

    const spec = buildDatasetRenderSpec({ dataset: dataset.slug, projectId: "swiss-bank-account" });

    expect(spec.root).toBe("root");
    expect(spec.elements.root.type).toBe("Table");
    const props = spec.elements.root.props as JsonObject;

    expect(props.title).toBe("Bank shortlist");
    expect(spec.metadata.renderer).toBe("json_render");
  });

  test("builds a non-overlap canvas spec with optional connections metadata", () => {
    ingestDataset({
      name: "Documents",
      projectId: "swiss-bank-account",
      rows: [{ document: "Potential contract", status: "review" }],
    });

    const spec = buildDatasetCanvasSpec({ projectId: "swiss-bank-account" });
    const root = spec.elements.root.props as JsonObject;

    expect(spec.metadata.renderer).toBe("react_flow");
    expect(root.ui_contract).toMatchObject({ connections_optional: true, non_overlapping_nodes: true });
    expect((root.nodes as JsonObject[]).length).toBe(3);
    expect((root.edges as JsonObject[]).length).toBe(2);
    expect((root.data as JsonObject).privacy).toMatchObject({ previews_bounded: true, raw_records_embedded: false });
  });
});
