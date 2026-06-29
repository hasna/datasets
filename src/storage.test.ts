import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DATASETS_DB_PATH_ENV,
  DATASETS_HOME_ENV,
  createDatasetProjection,
  createSource,
  getDataset,
  ingestDataset,
  listDatasets,
  listProjections,
  listSources,
  previewDataset,
  storageStatus,
} from "./storage.js";

const ENV_KEYS = [DATASETS_HOME_ENV, DATASETS_DB_PATH_ENV] as const;
const savedEnv = new Map<string, string | undefined>();
let testDir: string | undefined;

for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "datasets-storage-"));
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

describe("open-datasets storage", () => {
  test("registers sources, ingests rows, and returns bounded previews", () => {
    const source = createSource({
      name: "Swiss paperwork CSV",
      kind: "csv",
      path: join(testDir!, "paperwork.csv"),
      projectId: "swiss-bank-account",
    });

    const { dataset, version } = ingestDataset({
      name: "Bank shortlist",
      projectId: "swiss-bank-account",
      sourceId: source.id,
      classification: "private",
      rows: [
        { Bank: "Mirabaud", Jurisdiction: "CH", Minimum: 1_000_000, Status: "research" },
        { Bank: "UBS", Jurisdiction: "CH", Minimum: 1_000_000, Status: "research" },
      ],
    });

    expect(source.slug).toBe("swiss-paperwork-csv");
    expect(dataset.slug).toBe("bank-shortlist");
    expect(dataset.projectId).toBe("swiss-bank-account");
    expect(version.rowCount).toBe(2);
    expect(listSources("swiss-bank-account")).toHaveLength(1);
    expect(listDatasets("swiss-bank-account")).toHaveLength(1);

    const preview = previewDataset("bank-shortlist", { limit: 1 }, "swiss-bank-account");
    expect(preview.rows).toEqual([{ bank: "Mirabaud", jurisdiction: "CH", minimum: 1_000_000, status: "research" }]);
    expect(preview.truncated).toBe(true);
    expect(Object.keys(dataset.schema.properties ?? {})).toEqual(["bank", "jurisdiction", "minimum", "status"]);
  });

  test("keeps duplicate dataset slugs unique per project", () => {
    const first = ingestDataset({ name: "Contracts", projectId: "alpha", rows: [{ id: "a" }] }).dataset;
    const second = ingestDataset({ name: "Contracts", projectId: "alpha", rows: [{ id: "b" }] }).dataset;
    const third = ingestDataset({ name: "Contracts", projectId: "beta", rows: [{ id: "c" }] }).dataset;

    expect(first.slug).toBe("contracts");
    expect(second.slug).toBe("contracts-2");
    expect(third.slug).toBe("contracts");
  });

  test("creates saved projections and exposes storage status", () => {
    const dataset = ingestDataset({ name: "Documents", projectId: "swiss-bank-account", rows: [{ id: "doc-1", type: "contract" }] }).dataset;
    const projection = createDatasetProjection({
      dataset: dataset.id,
      name: "Contract cards",
      kind: "cards",
      query: { filters: { type: "contract" } },
    });

    expect(projection.slug).toBe("contract-cards");
    expect(listProjections(dataset.id)).toHaveLength(1);
    expect(getDataset(dataset.slug, "swiss-bank-account")?.id).toBe(dataset.id);
    expect(storageStatus()).toMatchObject({ sources: 0, datasets: 1, records: 1, exists: true });
  });
});
