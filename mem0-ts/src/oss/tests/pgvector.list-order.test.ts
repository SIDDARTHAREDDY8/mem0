// Regression test for https://github.com/mem0ai/mem0/issues/7383
//
// PGVector.list() issued LIMIT with no ORDER BY, so Memory.getAll() returned an
// arbitrary subset once a user's memory count exceeded topK. add() is additive
// (a correction stores a new memory), so the arbitrary subset could drop a
// user's most recent correction while the superseded fact remained visible.
//
// The mock emulates the two Postgres behaviors at play:
//  * with ORDER BY created_at DESC: rows come back newest-first (deterministic)
//  * without it: heap order is arbitrary, here simulated as a fixed scramble
// The first test pins the emitted SQL itself; the second proves the newest N
// memories are returned deterministically when topK < total count.

interface MockRow {
  id: string;
  payload: Record<string, any>;
  createdAt: string;
}

// Five memories for one user_id, inserted in this order (m1 oldest, m5 newest).
const listRows: MockRow[] = [
  {
    id: "m1",
    payload: { data: "likes tea", user_id: "u1" },
    createdAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "m2",
    payload: { data: "likes coffee", user_id: "u1" },
    createdAt: "2026-02-01T00:00:00Z",
  },
  {
    id: "m3",
    payload: { data: "allergic to peanuts", user_id: "u1" },
    createdAt: "2026-03-01T00:00:00Z",
  },
  {
    id: "m4",
    payload: { data: "plays chess", user_id: "u1" },
    createdAt: "2026-04-01T00:00:00Z",
  },
  {
    id: "m5",
    payload: { data: "corrected: likes espresso", user_id: "u1" },
    createdAt: "2026-05-01T00:00:00Z",
  },
];

// A heap-order scramble: arbitrary, not insertion order, not newest-first.
const scrambledRows = [
  listRows[2],
  listRows[0],
  listRows[4],
  listRows[1],
  listRows[3],
];

const mockState = {
  databaseExists: true,
  existingCollections: ["memories"],
};

function mockPgQuery(sql: string) {
  if (sql.includes("SELECT 1 FROM pg_database")) {
    return { rows: mockState.databaseExists ? [{ "?column?": 1 }] : [] };
  }

  if (sql.includes("FROM information_schema.tables")) {
    return {
      rows: mockState.existingCollections.map((table_name) => ({ table_name })),
    };
  }

  if (sql.includes("SELECT COUNT(*)")) {
    return { rows: [{ count: String(listRows.length) }] };
  }

  if (sql.includes("SELECT id, payload") && sql.includes("LIMIT")) {
    // Emulate Postgres: ORDER BY created_at DESC yields newest-first rows.
    if (sql.includes("ORDER BY created_at DESC")) {
      return {
        rows: [...listRows]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 3),
      };
    }
    // Without ORDER BY the row order is arbitrary (heap order).
    return { rows: scrambledRows.slice(0, 3) };
  }

  return { rows: [] };
}

jest.mock("pg", () => {
  const clients: any[] = [];

  const Client = jest.fn().mockImplementation((config: any) => {
    const client = {
      config,
      connect: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
      query: jest
        .fn()
        .mockImplementation(async (sql: string) => mockPgQuery(sql)),
    };

    clients.push(client);
    return client;
  });

  const escapeIdentifier = (str: string) => `"${str.replace(/"/g, '""')}"`;

  return {
    __esModule: true,
    default: { Client, escapeIdentifier },
    Client,
    escapeIdentifier,
    __mock: { Client, clients },
  };
});

import { PGVector } from "../src/vector_stores/pgvector";

function getClientQueries(client: { query: jest.Mock }) {
  return client.query.mock.calls.map(([sql]) => sql as string);
}

function makeStore(collectionName = "memories") {
  return new PGVector({
    collectionName,
    connectionString: "postgresql://postgres:postgres@localhost:5432/neondb",
    embeddingModelDims: 3,
    dimension: 3,
  } as any);
}

function getOnlyClient() {
  const pg = require("pg");
  expect(pg.__mock.clients).toHaveLength(1);
  return pg.__mock.clients[0];
}

describe("PGVector.list() ordering (issue #7383)", () => {
  beforeEach(() => {
    const pg = require("pg");
    mockState.databaseExists = true;
    mockState.existingCollections = ["memories"];
    pg.__mock.Client.mockClear();
    pg.__mock.clients.length = 0;
  });

  test("list() emits ORDER BY created_at DESC with the LIMIT", async () => {
    const store = makeStore();
    await store.initialize();
    await store.list({ user_id: "u1" }, 3);

    const queries = getClientQueries(getOnlyClient());
    const listQuery = queries.find(
      (sql) => sql.includes("SELECT id, payload") && sql.includes("LIMIT"),
    );
    expect(listQuery).toBeDefined();
    expect(listQuery).toContain("ORDER BY created_at DESC");
  });

  test("list() returns the newest N memories deterministically past topK", async () => {
    const store = makeStore();
    await store.initialize();

    const [memories, count] = await store.list({ user_id: "u1" }, 3);

    expect(count).toBe(5);
    expect(memories.map((m) => m.id)).toEqual(["m5", "m4", "m3"]);
    expect(memories[0].payload).toEqual({
      data: "corrected: likes espresso",
      user_id: "u1",
    });
  });

  test("new collections are created with a created_at column", async () => {
    mockState.existingCollections = [];
    const store = makeStore("brand_new");
    await store.initialize();

    const queries = getClientQueries(getOnlyClient());
    const createTable = queries.find(
      (sql) =>
        sql.includes("CREATE TABLE IF NOT EXISTS") &&
        sql.includes('"brand_new"'),
    );
    expect(createTable).toBeDefined();
    expect(createTable).toMatch(/created_at\s+TIMESTAMPTZ/i);
  });

  test("existing collections get created_at backfilled at initialize", async () => {
    const store = makeStore();
    await store.initialize();

    const queries = getClientQueries(getOnlyClient());
    expect(queries).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/ADD COLUMN IF NOT EXISTS created_at/i),
      ]),
    );
  });
});
