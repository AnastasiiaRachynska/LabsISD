"use strict";

const {
  AUDIT_LOG_MAX_BYTES,
  createSqliteRepositories,
} = require("../src/bootstrap/sqlite-repositories");

function createDatabase() {
  return {
    runAsync: jest.fn(async () => ({ changes: 1, lastInsertRowId: 1 })),
    getFirstAsync: jest.fn(async () => null),
    getAllAsync: jest.fn(async () => []),
    withTransactionAsync: jest.fn(async (work) => work()),
  };
}

describe("SQLite repositories", () => {
  test("requires the async Expo SQLite API", () => {
    expect(() => createSqliteRepositories(null)).toThrow(
      "SQLite repositories require a valid Expo SQLite database.",
    );
    expect(() => createSqliteRepositories({ runAsync: jest.fn() })).toThrow(
      "SQLite repositories require a valid Expo SQLite database.",
    );
  });

  test("persists Entry records and maps stored relationship data", async () => {
    const database = createDatabase();
    database.getFirstAsync.mockResolvedValue({
      id: "entry-1",
      content: "An idea",
      title: null,
      display_title: "An idea",
      entry_type: "General Note",
      created_at: "2026-01-02T03:04:05.000Z",
      updated_at: "2026-01-02T03:04:05.000Z",
    });
    const repositories = createSqliteRepositories(database);

    await expect(
      repositories.entries.create({
        id: "entry-1",
        content: "An idea",
        title: null,
        displayTitle: "An idea",
        entryType: "General Note",
        tags: [],
        bookAssociations: [],
        chapterAssociations: [],
        entryLinks: [],
      }),
    ).resolves.toMatchObject({
      id: "entry-1",
      content: "An idea",
      displayTitle: "An idea",
      tags: [],
      bookAssociations: [],
      chapterAssociations: [],
      entryLinks: [],
    });
    expect(database.withTransactionAsync).toHaveBeenCalledTimes(1);
    expect(database.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO entries"),
      "entry-1",
      "An idea",
      null,
      "An idea",
      "General Note",
    );
  });

  test("creates and retrieves Books, Chapters, and Tags through their repositories", async () => {
    const database = createDatabase();
    database.getFirstAsync.mockImplementation(async (sql) => {
      if (sql.includes("FROM books")) {
        return { id: "book-1", name: "Book One", created_at: "created", updated_at: "updated" };
      }
      if (sql.includes("FROM chapters")) {
        return {
          id: "chapter-1",
          book_id: "book-1",
          name: "Chapter One",
          created_at: "created",
          updated_at: "updated",
        };
      }
      if (sql.includes("FROM tags")) {
        return { id: "tag-1", name: "Mystery", created_at: "created", updated_at: "updated" };
      }
      return null;
    });
    const repositories = createSqliteRepositories(database);

    await expect(
      repositories.books.create({ id: "book-1", name: "Book One" }),
    ).resolves.toMatchObject({ id: "book-1", name: "Book One" });
    await expect(
      repositories.chapters.create({ id: "chapter-1", bookId: "book-1", name: "Chapter One" }),
    ).resolves.toMatchObject({ id: "chapter-1", bookId: "book-1", name: "Chapter One" });
    await expect(
      repositories.tags.create({ id: "tag-1", name: "Mystery" }),
    ).resolves.toMatchObject({ id: "tag-1", name: "Mystery" });
    expect(database.runAsync).toHaveBeenCalledWith(
      "INSERT INTO chapters (id, book_id, name) VALUES (?, ?, ?);",
      "chapter-1",
      "book-1",
      "Chapter One",
    );
  });

  test("updates, deletes, and lists named records and Tags", async () => {
    const database = createDatabase();
    database.runAsync
      .mockResolvedValueOnce({ changes: 1 })
      .mockResolvedValueOnce({ changes: 0 })
      .mockResolvedValueOnce({ changes: 1 })
      .mockResolvedValueOnce({ changes: 1 })
      .mockResolvedValueOnce({ changes: 0 })
      .mockResolvedValueOnce({ changes: 0 });
    database.getFirstAsync
      .mockResolvedValueOnce({ id: "book-1", name: "Renamed", created_at: "created", updated_at: "updated" })
      .mockResolvedValueOnce({ id: "tag-1", name: "Mystery", created_at: "created", updated_at: "updated" })
    database.getAllAsync
      .mockResolvedValueOnce([{ id: "book-1", name: "Renamed", created_at: "created", updated_at: "updated" }])
      .mockResolvedValueOnce([{ id: "tag-1", name: "Mystery", created_at: "created", updated_at: "updated" }]);
    const repositories = createSqliteRepositories(database);

    await expect(repositories.books.update("book-1", { name: "Renamed" })).resolves.toMatchObject({
      name: "Renamed",
    });
    await expect(repositories.books.update("missing", { name: "Unused" })).resolves.toBeNull();
    await expect(repositories.books.list()).resolves.toMatchObject([{ id: "book-1" }]);
    await expect(repositories.books.delete("book-1")).resolves.toBe(true);

    await expect(repositories.tags.update("tag-1", { name: "Mystery" })).resolves.toMatchObject({
      name: "Mystery",
    });
    await expect(repositories.tags.update("missing", { name: "Unused" })).resolves.toBeNull();
    await expect(repositories.tags.list()).resolves.toMatchObject([{ id: "tag-1" }]);
    await expect(repositories.tags.delete("missing")).resolves.toBe(false);
    await expect(repositories.chapters.listByBookId("book-1")).resolves.toEqual([]);

    await expect(repositories.books.update("book-1", { name: " " })).rejects.toThrow(
      "Book name must be a nonblank string.",
    );
    await expect(repositories.tags.create({ id: "", name: "Tag" })).rejects.toThrow(
      "Tag ID must be a nonblank string.",
    );
  });

  test("updates Entry columns and replaces only the supplied relationship sets", async () => {
    const database = createDatabase();
    const storedEntry = {
      id: "entry-1",
      content: "Updated content",
      title: null,
      display_title: "Updated content",
      entry_type: "General Note",
      created_at: "created",
      updated_at: "updated",
    };
    database.getFirstAsync
      .mockResolvedValueOnce({ ...storedEntry, content: "Original content", display_title: "Original content" })
      .mockResolvedValueOnce(storedEntry);
    const repositories = createSqliteRepositories(database);

    await expect(
      repositories.entries.update("entry-1", {
        content: "Updated content",
        tags: [],
        bookAssociations: [],
        chapterAssociations: [],
        entryLinks: [],
      }),
    ).resolves.toMatchObject({ content: "Updated content" });
    expect(database.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE entries"),
      "Updated content",
      null,
      "Updated content",
      "General Note",
      "entry-1",
    );
    expect(database.withTransactionAsync).toHaveBeenCalledTimes(1);
  });

  test("returns null for missing Entries and rejects invalid Entry data", async () => {
    const database = createDatabase();
    const repositories = createSqliteRepositories(database);

    await expect(repositories.entries.findById("missing")).resolves.toBeNull();
    await expect(repositories.entries.update("missing", {})).resolves.toBeNull();
    await expect(repositories.entries.create({ id: "e", content: " " })).rejects.toThrow(
      "Entry Content must be a nonblank string.",
    );
    await expect(repositories.entries.update("missing", null)).resolves.toBeNull();
    await expect(repositories.entries.update("missing", { unknownField: true })).resolves.toBeNull();
  });

  test("stores typed associations and preserves symmetric Entry Links", async () => {
    const database = createDatabase();
    database.getAllAsync.mockResolvedValue([{ entryId: "entry-a" }]);
    const repositories = createSqliteRepositories(database);

    await repositories.entryTags.add("entry-1", "tag-1");
    await repositories.entryTags.remove("entry-1", "tag-1");
    await repositories.entryBooks.add("entry-1", "book-1", "chapter-derived");
    await expect(
      repositories.entryBooks.add("entry-1", "book-1", "invalid"),
    ).rejects.toThrow("Book Association source must be direct or chapter-derived.");
    await repositories.entryBooks.remove("entry-1", "book-1", "chapter-derived");
    await repositories.entryChapters.add("entry-1", "chapter-1");
    await repositories.entryChapters.remove("entry-1", "chapter-1");
    await repositories.entryLinks.add("entry-b", "entry-a");
    await repositories.entryLinks.remove("entry-a", "entry-b");
    await expect(repositories.entryLinks.add("entry-a", "entry-a")).rejects.toThrow(
      "An Entry cannot be linked to itself.",
    );
    await expect(repositories.entryLinks.listForEntry("entry-a")).resolves.toEqual([
      { entryId: "entry-a" },
    ]);

    expect(database.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("INSERT OR IGNORE INTO entry_links"),
      "entry-a",
      "entry-b",
    );
  });

  test("lists and replaces Entry Tags and Book Associations while preserving derived links", async () => {
    const database = createDatabase();
    database.getAllAsync
      .mockResolvedValueOnce([{ id: "tag-1", name: "Mystery" }])
      .mockResolvedValueOnce([{ bookId: "book-1", source: "direct" }])
      .mockResolvedValueOnce([{ entryId: "entry-1", source: "direct" }]);
    const repositories = createSqliteRepositories(database);

    await expect(repositories.entryTags.listForEntry("entry-1")).resolves.toMatchObject([
      { id: "tag-1", name: "Mystery" },
    ]);
    await repositories.entryTags.replaceForEntry("entry-1", ["tag-1"]);
    await expect(repositories.entryBooks.listForEntry("entry-1")).resolves.toEqual([
      { bookId: "book-1", source: "direct" },
    ]);
    await expect(repositories.entryBooks.listForBook("book-1")).resolves.toEqual([
      { entryId: "entry-1", source: "direct" },
    ]);
    await repositories.entryBooks.detachBook("book-1");
    await repositories.entryBooks.replaceDirectForEntry("entry-1", [
      "book-1",
      { bookId: "book-2", source: "direct" },
      { bookId: "book-3", source: "chapter-derived" },
    ]);

    expect(database.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("INSERT OR IGNORE INTO entry_books"),
      "entry-1",
      "book-2",
      "direct",
    );
    expect(database.runAsync).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT OR IGNORE INTO entry_books"),
      "entry-1",
      "book-3",
      "direct",
    );
  });

  test("rejects malformed Entry changes and invalid association identifiers", async () => {
    const database = createDatabase();
    database.getFirstAsync.mockResolvedValue({
      id: "entry-1",
      content: "An idea",
      title: null,
      display_title: "An idea",
      entry_type: "General Note",
    });
    const repositories = createSqliteRepositories(database);

    await expect(repositories.entries.update("entry-1", null)).rejects.toThrow(
      "Entry changes must be an object.",
    );
    await expect(repositories.entries.update("entry-1", { surprise: true })).rejects.toThrow(
      "Entry changes contain unsupported fields.",
    );
    await expect(repositories.entries.update("entry-1", { tags: "not-an-array" })).rejects.toThrow(
      "tags must be an array.",
    );
    await expect(
      repositories.entryBooks.replaceDirectForEntry("entry-1", [{}]),
    ).rejects.toThrow("book must be a nonblank string.");
    await expect(
      repositories.entryChapters.add("entry-1", "chapter-1"),
    ).resolves.toBeUndefined();
  });

  test("replaces Chapter associations and removes orphaned derived Book links", async () => {
    const database = createDatabase();
    database.getAllAsync.mockResolvedValueOnce([
      { id: "chapter-1", bookId: "book-1" },
    ]);
    database.getFirstAsync.mockImplementation(async (sql) => {
      if (sql.startsWith("SELECT * FROM chapters")) {
        return { id: "chapter-2", book_id: "book-2", name: "Other Chapter" };
      }
      return null;
    });
    const repositories = createSqliteRepositories(database);

    await repositories.entries.create({
      id: "entry-1",
      content: "An idea",
      title: null,
      displayTitle: "An idea",
      entryType: "General Note",
      tags: [],
      bookAssociations: [],
      chapterAssociations: ["chapter-2"],
      entryLinks: [],
    });

    expect(database.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("INSERT OR IGNORE INTO entry_books"),
      "entry-1",
      "book-2",
      "chapter-derived",
    );
    expect(database.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("source = ?"),
      "entry-1",
      "book-1",
      "chapter-derived",
    );
  });

  test("clears relationships on updates, lists Entries, and rejects invalid Entry Types", async () => {
    const database = createDatabase();
    const row = {
      id: "entry-1",
      content: "An idea",
      title: null,
      display_title: "An idea",
      entry_type: "General Note",
      created_at: "created",
      updated_at: "updated",
    };
    database.getFirstAsync.mockResolvedValue(row);
    database.getAllAsync.mockResolvedValue([]);
    const repositories = createSqliteRepositories(database);

    await expect(repositories.entries.list()).resolves.toHaveLength(0);
    await expect(
      repositories.entries.create({
        id: "entry-2",
        content: "An idea",
        title: null,
        displayTitle: "An idea",
        entryType: "Unknown",
      }),
    ).rejects.toThrow("Entry Type is not supported.");
    await expect(
      repositories.entries.update("entry-1", { entryType: "Unknown" }),
    ).rejects.toThrow("Entry Type is not supported.");
    await expect(
      repositories.entries.update("entry-1", { content: " " }),
    ).rejects.toThrow("Entry Content must be a nonblank string.");
    await expect(
      repositories.entries.update("entry-1", { displayTitle: " " }),
    ).rejects.toThrow("Entry Display Title must be a nonblank string.");
  });

  test("detaching a Chapter removes its derived Book link only when no sibling remains", async () => {
    const database = createDatabase();
    database.getFirstAsync
      .mockResolvedValueOnce({ book_id: "book-1" })
      .mockResolvedValueOnce(null);
    database.getAllAsync.mockResolvedValue([{ entry_id: "entry-1" }]);
    const repositories = createSqliteRepositories(database);

    await repositories.entryChapters.detachChapter("chapter-1");

    expect(database.withTransactionAsync).toHaveBeenCalledTimes(1);
    expect(database.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("source = 'chapter-derived'"),
      "entry-1",
      "book-1",
    );
  });

  test("does nothing when detaching an unknown Chapter", async () => {
    const database = createDatabase();
    const repositories = createSqliteRepositories(database);

    await repositories.entryChapters.detachChapter("missing");

    expect(database.getAllAsync).not.toHaveBeenCalled();
    expect(database.runAsync).not.toHaveBeenCalled();
  });

  test("keeps the derived Book association if another Chapter in that Book remains", async () => {
    const database = createDatabase();
    database.getFirstAsync
      .mockResolvedValueOnce({ book_id: "book-1" })
      .mockResolvedValueOnce({ found: 1 });
    database.getAllAsync.mockResolvedValue([{ entry_id: "entry-1" }]);
    const repositories = createSqliteRepositories(database);

    await repositories.entryChapters.detachChapter("chapter-1");

    expect(database.runAsync).not.toHaveBeenCalledWith(
      expect.stringContaining("source = 'chapter-derived'"),
      expect.anything(),
      expect.anything(),
    );
  });

  test("queues pending changes and stores synchronization metadata", async () => {
    const database = createDatabase();
    database.getAllAsync.mockResolvedValue([
      {
        id: 1,
        operation: "create",
        resource_type: "entry",
        resource_id: "entry-1",
        payload: "{}",
        enqueued_at: "2026-01-02T03:04:05.000Z",
      },
    ]);
    database.getFirstAsync.mockResolvedValue({ value: "cursor-1" });
    const repositories = createSqliteRepositories(database);

    await repositories.pendingChanges.enqueue({
      operation: "create",
      resourceType: "entry",
      resourceId: "entry-1",
    });
    await expect(repositories.pendingChanges.list()).resolves.toMatchObject([
      { operation: "create", resourceType: "entry", resourceId: "entry-1", payload: {} },
    ]);
    await repositories.pendingChanges.removeThrough(1);
    await expect(repositories.syncMetadata.get("cursor")).resolves.toBe("cursor-1");
    await repositories.syncMetadata.set("cursor", "cursor-2");
    await expect(
      repositories.pendingChanges.enqueue({
        operation: "unsupported",
        resourceType: "entry",
        resourceId: "entry-1",
      }),
    ).rejects.toThrow("Pending change operation is not supported.");
    await expect(repositories.syncMetadata.set("", "cursor")).rejects.toThrow();

    expect(database.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO pending_changes"),
      "create",
      "entry",
      "entry-1",
      "{}",
    );
  });

  test("rejects incomplete pending changes and non-string metadata values", async () => {
    const repositories = createSqliteRepositories(createDatabase());

    await expect(repositories.pendingChanges.enqueue(null)).rejects.toThrow(
      "Pending change must be an object.",
    );
    await expect(
      repositories.pendingChanges.enqueue({ operation: "create", resourceId: "entry-1" }),
    ).rejects.toThrow("Pending change resource type must be a nonblank string.");
    await expect(repositories.syncMetadata.set("cursor", 12)).rejects.toThrow(
      "Sync metadata value must be a string.",
    );
  });

  test("records audit events and removes the oldest events over the size limit", async () => {
    const database = createDatabase();
    database.getFirstAsync
      .mockResolvedValueOnce({ totalBytes: AUDIT_LOG_MAX_BYTES + 50 })
      .mockResolvedValueOnce({ id: 1, bytes: 75 });
    const repositories = createSqliteRepositories(database);

    const event = {
      event: "entry.create",
      resourceId: "entry-1",
      occurredAt: "2026-01-02T03:04:05.000Z",
    };
    database.getAllAsync.mockResolvedValue([{ payload: JSON.stringify(event) }]);
    await repositories.auditLog.record(event);
    await expect(repositories.auditLog.list()).resolves.toEqual([event]);
    await expect(
      repositories.auditLog.record({ ...event, occurredAt: "not-a-timestamp" }),
    ).rejects.toThrow("Audit event timestamp must be ISO-8601 UTC.");

    expect(database.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM diagnostic_events"),
      1,
    );
  });

  test("does not rotate an audit log within its size limit and rejects incomplete events", async () => {
    const database = createDatabase();
    database.getFirstAsync.mockResolvedValue({ totalBytes: 10 });
    database.getAllAsync.mockResolvedValue([]);
    const repositories = createSqliteRepositories(database);

    await repositories.auditLog.record({
      event: "entry.update",
      resourceId: "entry-1",
      occurredAt: "2026-01-02T03:04:05.000Z",
    });
    await expect(repositories.auditLog.list()).resolves.toEqual([]);
    await expect(repositories.auditLog.record(null)).rejects.toThrow(
      "Audit event must be an object.",
    );
    await expect(
      repositories.auditLog.record({
        event: "",
        resourceId: "entry-1",
        occurredAt: "2026-01-02T03:04:05.000Z",
      }),
    ).rejects.toThrow("Audit event name must be a nonblank string.");
  });
});
