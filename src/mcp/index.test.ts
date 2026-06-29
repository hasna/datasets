import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATASETS_DB_PATH_ENV, DATASETS_HOME_ENV, ingestDataset } from "../storage.js";
import { buildServer } from "./index.js";

const ENV_KEYS = [
  DATASETS_HOME_ENV,
  DATASETS_DB_PATH_ENV,
  "OPEN_DATASETS_MCP_ALLOW_MUTATIONS",
  "OPEN_DATASETS_MCP_ALLOW_IMPORTS",
  "OPEN_DATASETS_MCP_ALLOW_ALL",
] as const;
const savedEnv = new Map<string, string | undefined>();
let testDir: string | undefined;

for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "datasets-mcp-"));
  process.env[DATASETS_HOME_ENV] = testDir;
  process.env[DATASETS_DB_PATH_ENV] = join(testDir, "datasets.db");
  delete process.env.OPEN_DATASETS_MCP_ALLOW_MUTATIONS;
  delete process.env.OPEN_DATASETS_MCP_ALLOW_IMPORTS;
  delete process.env.OPEN_DATASETS_MCP_ALLOW_ALL;
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

describe("datasets MCP", () => {
  test("read tools work by default", async () => {
    ingestDataset({
      name: "Bank shortlist",
      projectId: "swiss-bank-account",
      rows: [{ bank: "Mirabaud", status: "research" }],
    });
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "datasets_preview",
        arguments: { dataset: "bank-shortlist", project: "swiss-bank-account", limit: 1 },
      });
      expect(result.isError).not.toBe(true);
      const preview = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      expect(preview.rows[0]).toMatchObject({ bank: "[redacted]" });
    } finally {
      await close();
    }
  });

  test("schema inference refuses raw local paths by default", async () => {
    const csvPath = join(testDir!, "raw.csv");
    writeFileSync(csvPath, "name\nsecret\n");
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "datasets_schema_infer",
        arguments: { ref: csvPath },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]?.text).toContain("Registered source or dataset not found");
    } finally {
      await close();
    }
  });

  test("mutation tools fail closed by default", async () => {
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "datasets_sources_add",
        arguments: { target: "memory://blocked", name: "Blocked" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]?.text).toContain("requires explicit capability");
    } finally {
      await close();
    }
  });

  test("mutation tools run when explicitly enabled", async () => {
    process.env.OPEN_DATASETS_MCP_ALLOW_MUTATIONS = "1";
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "datasets_sources_add",
        arguments: { target: "memory://allowed", name: "Allowed", kind: "manual", project: "swiss-bank-account" },
      });
      expect(result.isError).not.toBe(true);
      const source = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      expect(source).toMatchObject({ name: "Allowed", kind: "manual", projectId: "swiss-bank-account" });
    } finally {
      await close();
    }
  });
});

async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "datasets-mcp-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
