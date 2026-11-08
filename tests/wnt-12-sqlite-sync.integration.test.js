"use strict";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const supportsNodeSqlite = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5);
const sqliteTest = supportsNodeSqlite ? test : test.skip;

sqliteTest("WNT-12 persists synchronized resources, cursors, queue acknowledgments, and conflicts", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { DatabaseSync } = require("node:sqlite");
  const { createApplication } = require("../src/bootstrap/create-application");
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "labsisd-sync-"));
  const databasePath = path.join(temporaryDirectory, "sync.db");
  let rawDatabase;

  function openDatabase() {
    rawDatabase = new DatabaseSync(databasePath);
    return {
      execAsync: async (sql) => rawDatabase.exec(sql),
      runAsync: async (sql, ...parameters) => rawDatabase.prepare(sql).run(...parameters),
      getFirstAsync: async (sql, ...parameters) =>
        rawDatabase.prepare(sql).get(...parameters) ?? null,
      getAllAsync: async (sql, ...parameters) => rawDatabase.prepare(sql).all(...parameters),
      withTransactionAsync: async (work) => {
        rawDatabase.exec("BEGIN;");
        try {
          const result = await work();
          rawDatabase.exec("COMMIT;");
          return result;
        } catch (error) {
          rawDatabase.exec("ROLLBACK;");
          throw error;
        }
      },
    };
  }

  let pullResponse = {
    status: 200,
    body: {
      changes: [
        {
          resourceType: "book",
          resourceId: "remote-book",
          operation: "create",
          version: 1,
          resource: { id: "remote-book", title: "Remote Book" },
        },
        {
          resourceType: "chapter",
          resourceId: "remote-chapter",
          operation: "create",
          version: 1,
          resource: {
            id: "remote-chapter",
            bookId: "remote-book",
            title: "Remote Chapter",
          },
        },
        {
          resourceType: "entry",
          resourceId: "remote-entry",
          operation: "create",
          version: 2,
          resource: {
            id: "remote-entry",
            content: "Pulled content",
            title: null,
            entryType: "General Note",
          },
        },
        {
          resourceType: "entry",
          resourceId: "remote-entry-2",
          operation: "create",
          version: 1,
          resource: {
            id: "remote-entry-2",
            content: "This remote note has more than twenty-five characters",
            title: null,
            entryType: "Scene",
          },
        },
        {
          resourceType: "entry",
          resourceId: "remote-entry-3",
          operation: "create",
          version: 1,
          resource: {
            id: "remote-entry-3",
            content: "First line\nSecond line",
            title: null,
            entryType: "General Note",
          },
        },
        {
          resourceType: "tag",
          resourceId: "remote-tag",
          operation: "create",
          version: 1,
          resource: { id: "remote-tag", name: "Remote Tag" },
        },
        {
          resourceType: "entryTagAssociation",
          resourceId: "remote-association",
          operation: "create",
          version: 1,
          resource: {
            id: "remote-association",
            entryId: "remote-entry",
            tagId: "remote-tag",
          },
        },
        {
          resourceType: "entryBookAssociation",
          resourceId: "remote-book-association",
          operation: "create",
          version: 1,
          resource: {
            id: "remote-book-association",
            entryId: "remote-entry",
            bookId: "remote-book",
            source: "direct",
          },
        },
        {
          resourceType: "entryChapterAssociation",
          resourceId: "remote-chapter-association",
          operation: "create",
          version: 1,
          resource: {
            id: "remote-chapter-association",
            entryId: "remote-entry",
            chapterId: "remote-chapter",
            bookId: "remote-book",
          },
        },
        {
          resourceType: "entryLink",
          resourceId: "remote-link",
          operation: "create",
          version: 1,
          resource: {
            id: "remote-link",
            entryIds: ["remote-entry", "remote-entry-2"],
          },
        },
      ],
      nextCursor: "cursor-1",
    },
  };
  const syncApi = {
    pushChanges: jest.fn(async ({ changes }) => ({
      status: 200,
      body: {
        results: [
          {
            changeId: changes[0].changeId,
            status: "acknowledged",
            resourceId: "server-entry",
            version: changes[0].operation === "create" ? 4 : 5,
          },
        ],
      },
    })),
    pullChanges: jest.fn(async () => pullResponse),
  };

  try {
    let nextId = 0;
    const application = await createApplication({
      openDatabase: async () => openDatabase(),
      createId: () => `push-batch-${++nextId}`,
      syncApi,
    });
    await application.repositories.pendingChanges.enqueue({
      operation: "create",
      resourceType: "entry",
      resourceId: "entry-local",
      payload: {
        id: "entry-local",
        content: "Queued content",
        entryType: "General Note",
      },
    });

    await expect(application.synchronization.pushPendingChanges()).resolves.toMatchObject({
      acknowledged: 1,
      remaining: 0,
    });
    expect(await application.repositories.pendingChanges.list()).toEqual([]);
    expect(
      await application.repositories.syncMetadata.get("version:entry:entry-local"),
    ).toBe("4");
    await application.repositories.pendingChanges.enqueue({
      operation: "update",
      resourceType: "entry",
      resourceId: "entry-local",
      baseVersion: 4,
      payload: {
        id: "entry-local",
        content: "Updated queued content",
        entryType: "General Note",
      },
    });
    await application.synchronization.pushPendingChanges();
    expect(syncApi.pushChanges.mock.calls[1][0].changes[0].resourceId).toBe("server-entry");

    await expect(application.synchronization.pullChanges()).resolves.toEqual({
      applied: 10,
      cursor: "cursor-1",
    });
    await expect(application.repositories.entries.findById("remote-entry")).resolves.toMatchObject({
      id: "remote-entry",
      content: "Pulled content",
    });
    expect(await application.repositories.syncMetadata.get("version:entry:remote-entry")).toBe("2");
    await expect(
      application.repositories.entryTags.listForEntry("remote-entry"),
    ).resolves.toMatchObject([{ id: "remote-tag", name: "Remote Tag" }]);
    await expect(application.repositories.books.findById("remote-book")).resolves.toMatchObject({
      name: "Remote Book",
    });
    await expect(
      application.repositories.chapters.findById("remote-chapter"),
    ).resolves.toMatchObject({ name: "Remote Chapter", bookId: "remote-book" });
    await expect(application.repositories.entries.findById("remote-entry-2")).resolves.toMatchObject({
      displayTitle: "This remote note has more...",
    });
    await expect(application.repositories.entries.findById("remote-entry-3")).resolves.toMatchObject({
      displayTitle: "First line...",
    });
    expect(await application.repositories.entryLinks.listForEntry("remote-entry")).toEqual([
      { entryId: "remote-entry-2" },
    ]);
    await expect(application.repositories.entryBooks.listForEntry("remote-entry")).resolves.toEqual([
      { bookId: "remote-book", source: "chapter-derived" },
      { bookId: "remote-book", source: "direct" },
    ]);

    pullResponse = {
      status: 200,
      body: {
        changes: [
          {
            resourceType: "entryTagAssociation",
            resourceId: "remote-association",
            operation: "delete",
            version: 2,
          },
          {
            resourceType: "entryBookAssociation",
            resourceId: "remote-book-association",
            operation: "delete",
            version: 2,
          },
          {
            resourceType: "entryLink",
            resourceId: "remote-link",
            operation: "delete",
            version: 2,
          },
        ],
        nextCursor: "cursor-2",
      },
    };
    await expect(application.synchronization.pullChanges()).resolves.toEqual({
      applied: 3,
      cursor: "cursor-2",
    });
    await expect(application.repositories.entryTags.listForEntry("remote-entry")).resolves.toEqual(
      [],
    );
    await expect(
      application.repositories.entryBooks.listForEntry("remote-entry"),
    ).resolves.toEqual([{ bookId: "remote-book", source: "chapter-derived" }]);
    await expect(
      application.repositories.entryChapters.listForEntry("remote-entry"),
    ).resolves.toMatchObject([{ id: "remote-chapter" }]);
    expect(await application.repositories.entryLinks.listForEntry("remote-entry")).toEqual([]);

    pullResponse = {
      status: 200,
      body: {
        changes: [
          { resourceType: "chapter", resourceId: "remote-chapter", operation: "delete", version: 2 },
          { resourceType: "entryChapterAssociation", resourceId: "remote-chapter-association", operation: "delete", version: 2 },
          { resourceType: "tag", resourceId: "remote-tag", operation: "delete", version: 2 },
          { resourceType: "book", resourceId: "remote-book", operation: "delete", version: 2 },
          { resourceType: "entry", resourceId: "remote-entry-2", operation: "delete", version: 2 },
        ],
        nextCursor: "cursor-3",
      },
    };
    await expect(application.synchronization.pullChanges()).resolves.toMatchObject({
      applied: 5,
      cursor: "cursor-3",
    });
    await expect(application.repositories.chapters.findById("remote-chapter")).resolves.toBeNull();
    await expect(application.repositories.tags.findById("remote-tag")).resolves.toBeNull();
    await expect(application.repositories.books.findById("remote-book")).resolves.toBeNull();
    await expect(application.repositories.entries.findById("remote-entry-2")).resolves.toBeNull();

    const conflict = {
      changeId: "conflict-1",
      resourceType: "entry",
      resourceId: "remote-entry",
      localVersion: { content: "Local" },
      serverVersion: { content: "Server", version: 5 },
    };
    await application.repositories.conflicts.save(conflict);
    await expect(
      application.repositories.conflicts.findByChangeId("conflict-1"),
    ).resolves.toEqual(conflict);

    pullResponse = {
      status: 200,
      body: {
        changes: [
          {
            resourceType: "chapter",
            resourceId: "orphan-chapter",
            operation: "create",
            version: 1,
            resource: { id: "orphan-chapter", bookId: "missing-book", name: "Orphan" },
          },
        ],
        nextCursor: "cursor-invalid",
      },
    };
    await expect(application.synchronization.pullChanges()).rejects.toThrow();
    expect(await application.repositories.syncMetadata.get("syncCursor")).toBe("cursor-3");
    expect(await application.repositories.chapters.findById("orphan-chapter")).toBeNull();
    const syncEvents = (await application.repositories.auditLog.list())
      .filter((event) => event.event.startsWith("sync."));
    expect(syncEvents.map((event) => event.event)).toEqual([
      "sync.push.completed",
      "sync.push.completed",
      "sync.pull.completed",
      "sync.pull.completed",
      "sync.pull.completed",
      "sync.pull.failed",
    ]);
  } finally {
    if (rawDatabase) {
      rawDatabase.close();
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
