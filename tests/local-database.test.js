"use strict";

const { SCHEMA_VERSION, initializeLocalDatabase } = require("../src/bootstrap/local-database");

describe("local database bootstrap", () => {
  test.each([
    ["missing connection", null],
    ["missing execAsync", { runAsync: jest.fn() }],
    ["missing runAsync", { execAsync: jest.fn() }],
    ["missing schema query", { execAsync: jest.fn(), runAsync: jest.fn() }],
  ])("rejects a database connection with %s", async (_case, database) => {
    await expect(initializeLocalDatabase(database)).rejects.toThrow(
      "A valid Expo SQLite database connection is required.",
    );
  });

  test("enables foreign keys and creates a schema version record", async () => {
    const database = {
      execAsync: jest.fn(async () => undefined),
      runAsync: jest.fn(async () => undefined),
      getFirstAsync: jest.fn(async () => null),
      withTransactionAsync: jest.fn(async (work) => work()),
    };

    await expect(initializeLocalDatabase(database)).resolves.toBe(database);

    expect(database.execAsync).toHaveBeenNthCalledWith(1, "PRAGMA foreign_keys = ON;");
    expect(database.execAsync).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("CREATE TABLE IF NOT EXISTS app_metadata"),
    );
    const schema = database.execAsync.mock.calls[2][0];
    for (const table of [
      "entries",
      "books",
      "chapters",
      "tags",
      "entry_tags",
      "entry_books",
      "entry_chapters",
      "entry_links",
      "pending_changes",
      "sync_metadata",
      "diagnostic_events",
    ]) {
      expect(schema).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(database.runAsync).toHaveBeenCalledWith(
      "INSERT OR REPLACE INTO app_metadata (key, value) VALUES (?, ?);",
      "schema_version",
      String(SCHEMA_VERSION),
    );
  });

  test("rejects a database created by a newer application version", async () => {
    const database = {
      execAsync: jest.fn(async () => undefined),
      runAsync: jest.fn(async () => undefined),
      getFirstAsync: jest.fn(async () => ({ value: String(SCHEMA_VERSION + 1) })),
      withTransactionAsync: jest.fn(async (work) => work()),
    };

    await expect(initializeLocalDatabase(database)).rejects.toThrow(
      "is newer than supported version",
    );
    expect(database.withTransactionAsync).not.toHaveBeenCalled();
  });

  test("does not rerun the schema migration for the current version", async () => {
    const database = {
      execAsync: jest.fn(async () => undefined),
      runAsync: jest.fn(async () => ({ changes: 1 })),
      getFirstAsync: jest.fn(async () => ({ value: String(SCHEMA_VERSION) })),
      withTransactionAsync: jest.fn(async (work) => work()),
    };

    await initializeLocalDatabase(database);

    expect(database.execAsync).toHaveBeenCalledTimes(2);
    expect(database.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("INSERT OR REPLACE"),
      "schema_version",
      String(SCHEMA_VERSION),
    );
  });

  test("migrates version 2 databases with sync persistence tables", async () => {
    const database = {
      execAsync: jest.fn(async () => undefined),
      runAsync: jest.fn(async () => ({ changes: 1 })),
      getFirstAsync: jest.fn(async () => ({ value: "2" })),
      withTransactionAsync: jest.fn(async (work) => work()),
    };

    await initializeLocalDatabase(database);

    expect(database.execAsync).toHaveBeenCalledWith(
      "ALTER TABLE pending_changes ADD COLUMN base_version INTEGER;",
    );
    expect(database.execAsync).toHaveBeenCalledWith(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS sync_conflicts"),
    );
    expect(database.execAsync).toHaveBeenCalledWith(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS sync_resource_ids"),
    );
  });

  test("rejects a malformed local schema version", async () => {
    const database = {
      execAsync: jest.fn(async () => undefined),
      runAsync: jest.fn(async () => ({ changes: 1 })),
      getFirstAsync: jest.fn(async () => ({ value: "invalid" })),
      withTransactionAsync: jest.fn(async (work) => work()),
    };

    await expect(initializeLocalDatabase(database)).rejects.toThrow(
      "The local database schema version is invalid.",
    );
  });
});
