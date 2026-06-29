import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATASETS_DB_PATH_ENV, DATASETS_HOME_ENV } from "../storage.js";

const repoRoot = join(import.meta.dir, "..", "..");
const cliEntry = join(repoRoot, "src", "cli", "index.ts");
const ENV_KEYS = [DATASETS_HOME_ENV, DATASETS_DB_PATH_ENV] as const;
const savedEnv = new Map<string, string | undefined>();
let testDir: string | undefined;

for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "datasets-cli-"));
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

describe("datasets CLI", () => {
  test("registers, ingests, previews, and emits project panel JSON", async () => {
    const fixtureDir = join(testDir!, "fixtures");
    mkdirSync(fixtureDir, { recursive: true });
    const csvPath = join(fixtureDir, "banks.csv");
    writeFileSync(csvPath, "Bank,Status,Formula\nMirabaud,research,=cmd\nUBS,research,+cmd\n");

    const source = await runJson(["sources", "add", csvPath, "--name", "Swiss bank CSV", "--project", "swiss-bank-account", "--json"]);
    expect(source.kind).toBe("csv");

    const result = await runJson(["ingest", source.id, "--name", "Bank shortlist", "--project", "swiss-bank-account", "--json"]);
    expect(result.dataset.rowCount).toBe(2);

    const preview = await runJson(["preview", "bank-shortlist", "--project", "swiss-bank-account", "--limit", "2", "--json"]);
    expect(preview.rows[0]).toMatchObject({ bank: "Mirabaud", formula: "'=cmd" });
    expect(preview.rows[1]).toMatchObject({ bank: "UBS", formula: "'+cmd" });

    const panel = await runJson(["project-panel", "--project", "swiss-bank-account", "--contract"]);
    expect(panel.provider.sourcePackage).toBe("@hasna/datasets");
    expect(panel.metrics.find((metric: { id: string }) => metric.id === "datasets")?.value).toBe(1);
  });
});

async function runJson(args: string[]): Promise<any> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", cliEntry, ...args],
    cwd: repoRoot,
    env: {
      ...process.env,
      [DATASETS_HOME_ENV]: process.env[DATASETS_HOME_ENV]!,
      [DATASETS_DB_PATH_ENV]: process.env[DATASETS_DB_PATH_ENV]!,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`datasets CLI failed (${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return JSON.parse(stdout);
}
