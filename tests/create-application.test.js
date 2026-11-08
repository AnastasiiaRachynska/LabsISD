"use strict";

const { createApplication } = require("../src/bootstrap/create-application");

describe("application composition", () => {
  test.each([
    [undefined, "Application startup requires database and ID factories."],
    [{ createId: () => "id" }, "Application startup requires database and ID factories."],
    [{ openDatabase: async () => ({}), createId: () => "id", now: "invalid" }, "Application startup requires a clock function."],
  ])("rejects invalid startup dependencies", async (options, message) => {
    await expect(createApplication(options)).rejects.toThrow(message);
  });

  test("opens SQLite and wires domain services to SQLite repositories", async () => {
    const database = {
      execAsync: jest.fn(async () => undefined),
      runAsync: jest.fn(async () => ({ changes: 1 })),
      getFirstAsync: jest.fn(async () => null),
      getAllAsync: jest.fn(async () => []),
      withTransactionAsync: jest.fn(async (work) => work()),
    };

    const application = await createApplication({
      openDatabase: jest.fn(async () => database),
      createId: () => "generated-id",
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    expect(application.database).toBe(database);
    expect(application.repositories.entries).toBeDefined();
    expect(application.repositories.books).toBeDefined();
    expect(application.repositories.chapters).toBeDefined();
    expect(application.repositories.tags).toBeDefined();
    expect(application.repositories.entryLinks).toBeDefined();
    expect(application.repositories.pendingChanges).toBeDefined();
    expect(application.repositories.syncMetadata).toBeDefined();
    expect(application.entryCapture).toEqual(
      expect.objectContaining({
        createEntry: expect.any(Function),
        updateEntry: expect.any(Function),
      }),
    );
    expect(application.bookOrganization).toEqual(
      expect.objectContaining({
        createBook: expect.any(Function),
        createChapter: expect.any(Function),
        addTagToEntry: expect.any(Function),
      }),
    );
    expect(application.entryRelationships).toEqual(
      expect.objectContaining({
        addEntryLink: expect.any(Function),
        removeEntryLink: expect.any(Function),
        listLinkedEntries: expect.any(Function),
        deleteEntry: expect.any(Function),
      }),
    );
    expect(application.entrySearch).toEqual(
      expect.objectContaining({
        searchEntries: expect.any(Function),
      }),
    );
    expect(application.exportService).toEqual(
      expect.objectContaining({
        exportEntry: expect.any(Function),
        exportBook: expect.any(Function),
      }),
    );
  });

  test("wires synchronization to SQLite repositories when a sync API is configured", async () => {
    const database = {
      execAsync: jest.fn(async () => undefined),
      runAsync: jest.fn(async () => ({ changes: 1 })),
      getFirstAsync: jest.fn(async () => null),
      getAllAsync: jest.fn(async () => []),
      withTransactionAsync: jest.fn(async (work) => work()),
    };
    const syncApi = {
      pushChanges: jest.fn(),
      pullChanges: jest.fn(),
    };
    const application = await createApplication({
      openDatabase: async () => database,
      createId: () => "sync-id",
      syncApi,
    });

    expect(application.synchronization).toEqual(
      expect.objectContaining({
        pushPendingChanges: expect.any(Function),
        pullChanges: expect.any(Function),
        resolveConflict: expect.any(Function),
      }),
    );
    expect(application.repositories.conflicts).toBeDefined();
  });

  test("rejects malformed sync transports and skips outbox work for missing Tags", async () => {
    const database = {
      execAsync: jest.fn(async () => undefined),
      runAsync: jest.fn(async () => ({ changes: 1 })),
      getFirstAsync: jest.fn(async () => null),
      getAllAsync: jest.fn(async () => []),
      withTransactionAsync: jest.fn(async (work) => work()),
    };
    const options = {
      openDatabase: async () => database,
      createId: () => "sync-id",
    };

    await expect(createApplication({ ...options, syncApi: {} })).rejects.toThrow(
      "Application sync API must implement",
    );
    const application = await createApplication(options);
    await expect(application.repositories.tags.update("missing", { name: "Updated" })).resolves.toBeNull();
    await expect(application.repositories.tags.delete("missing")).resolves.toBe(true);
    expect(await application.repositories.pendingChanges.list()).toEqual([]);
  });
});
