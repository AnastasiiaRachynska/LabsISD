"use strict";

const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "..");
const srs = fs.readFileSync(path.join(repositoryRoot, "spec/srs.tex"), "utf8");
const traceabilityMatrix = fs.readFileSync(
  path.join(repositoryRoot, "spec/traceability-matrix.tex"),
  "utf8",
);

const requirementMap = [
  ["REQ-F-009", "AC-F-009"],
  ["REQ-F-011", "AC-F-011"],
  ["REQ-F-012", "AC-F-012"],
  ["REQ-F-013", "AC-F-013"],
  ["REQ-F-014", "AC-F-014"],
  ["REQ-F-015", "AC-F-015"],
  ["REQ-F-016", "AC-F-016"],
  ["REQ-NF-005", "AC-NF-005"],
  ["REQ-NF-012", "AC-NF-012"],
];

function loadSystemUnderTest() {
  return require("../src/wnt07/book-organization");
}

function createRepository(initialRecords = []) {
  const records = new Map(initialRecords.map((record) => [record.id, { ...record }]));
  return {
    create: jest.fn(async (record) => {
      records.set(record.id, { ...record });
      return { ...record };
    }),
    findById: jest.fn(async (id) => {
      const record = records.get(id);
      return record ? { ...record } : null;
    }),
    update: jest.fn(async (id, changes) => {
      const record = records.get(id);
      if (!record) return null;
      const updated = { ...record, ...changes };
      records.set(id, updated);
      return { ...updated };
    }),
    delete: jest.fn(async (id) => records.delete(id)),
    list: jest.fn(async () => [...records.values()].map((record) => ({ ...record }))),
    listByBookId: jest.fn(async (bookId) =>
      [...records.values()]
        .filter((record) => record.bookId === bookId)
        .map((record) => ({ ...record })),
    ),
  };
}

function createHarness() {
  const books = createRepository([
    { id: "book-1", name: "Book One" },
    { id: "book-2", name: "Book Two" },
  ]);
  const chapters = createRepository([
    { id: "chapter-1", bookId: "book-1", name: "Chapter One" },
  ]);
  const entries = createRepository([
    { id: "entry-1", content: "An idea" },
    { id: "entry-2", content: "Another idea" },
  ]);
  const tags = createRepository([{ id: "tag-1", name: "Mystery" }]);
  const entryTags = {
    add: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
    listForEntry: jest.fn(async () => []),
  };
  const entryBooks = {
    add: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
    listForEntry: jest.fn(async () => []),
    listForBook: jest.fn(async () => []),
    detachBook: jest.fn(async () => undefined),
  };
  const entryChapters = {
    add: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
    listForEntry: jest.fn(async () => []),
    detachChapter: jest.fn(async () => undefined),
  };
  const auditLog = { record: jest.fn(async () => undefined) };
  let nextId = 0;
  const { createBookOrganizationService } = loadSystemUnderTest();

  return {
    books,
    chapters,
    entries,
    tags,
    entryTags,
    entryBooks,
    entryChapters,
    auditLog,
    service: createBookOrganizationService({
      books,
      chapters,
      entries,
      tags,
      entryTags,
      entryBooks,
      entryChapters,
      auditLog,
      createId: () => `resource-${++nextId}`,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    }),
  };
}

describe("WNT-07 SRS and acceptance-criteria traceability", () => {
  test.each(requirementMap)("%s maps to %s and WNT-07", (requirementId, criterionId) => {
    expect(srs).toContain(requirementId);
    expect(srs).toContain(criterionId);

    const row = traceabilityMatrix
      .split(/\r?\n/)
      .find((line) => line.includes(`${requirementId} & ${criterionId}`));
    expect(row).toContain("WNT-07");
  });
});

describe("WNT-07 Book and Chapter organization", () => {
  test("[REQ-F-009] adds and removes a Tag from an Entry", async () => {
    const { service, entries, tags, entryTags } = createHarness();
    entryTags.listForEntry.mockResolvedValue([{ id: "tag-1", name: "Mystery" }]);

    await service.addTagToEntry("entry-1", "tag-1");

    expect(entries.findById).toHaveBeenCalledWith("entry-1");
    expect(tags.findById).toHaveBeenCalledWith("tag-1");
    expect(entryTags.add).toHaveBeenCalledWith("entry-1", "tag-1");
    await expect(service.listTagsForEntry("entry-1")).resolves.toEqual([
      { id: "tag-1", name: "Mystery" },
    ]);

    await service.removeTagFromEntry("entry-1", "tag-1");

    expect(entryTags.remove).toHaveBeenCalledWith("entry-1", "tag-1");
  });

  test("[REQ-F-009, REQ-NF-005] rejects adding a Tag to a missing Entry", async () => {
    const { service, entries, entryTags } = createHarness();
    entries.findById.mockResolvedValue(null);

    await expect(service.addTagToEntry("missing-entry", "tag-1")).rejects.toThrow();

    expect(entryTags.add).not.toHaveBeenCalled();
  });

  test("[REQ-F-011] creates, lists, views, edits, and deletes Books", async () => {
    const { service, books } = createHarness();

    const book = await service.createBook({ name: "New Book" });
    expect(book).toMatchObject({ id: "resource-1", name: "New Book" });
    await expect(service.listBooks()).resolves.toContainEqual(book);
    await expect(service.getBook(book.id)).resolves.toMatchObject(book);

    await expect(service.updateBook(book.id, { name: "Renamed Book" })).resolves.toMatchObject({
      name: "Renamed Book",
    });
    await service.deleteBook(book.id);

    expect(books.update).toHaveBeenCalledWith(book.id, { name: "Renamed Book" });
    expect(books.delete).toHaveBeenCalledWith(book.id);
  });

  test("[REQ-F-011, REQ-NF-005] deleting a Book detaches its Entry relationships without deleting Entries", async () => {
    const { service, entries, entryBooks } = createHarness();
    entryBooks.detachBook.mockImplementation(async (bookId) => {
      expect(bookId).toBe("book-1");
    });

    await service.deleteBook("book-1");

    expect(entryBooks.detachBook).toHaveBeenCalledWith("book-1");
    expect(entries.delete).not.toHaveBeenCalled();
    await expect(entries.findById("entry-1")).resolves.toMatchObject({
      id: "entry-1",
      content: "An idea",
    });
  });

  test("[REQ-F-012] creates, lists, views, edits, and deletes Chapters within a Book", async () => {
    const { service, chapters, books } = createHarness();

    const chapter = await service.createChapter("book-1", { name: "New Chapter" });
    expect(chapter).toMatchObject({
      id: "resource-1",
      bookId: "book-1",
      name: "New Chapter",
    });
    expect(books.findById).toHaveBeenCalledWith("book-1");
    await expect(service.listChapters("book-1")).resolves.toContainEqual(chapter);
    await expect(service.getChapter(chapter.id)).resolves.toMatchObject(chapter);

    await expect(
      service.updateChapter(chapter.id, { name: "Renamed Chapter" }),
    ).resolves.toMatchObject({ name: "Renamed Chapter" });
    await service.deleteChapter(chapter.id);

    expect(chapters.update).toHaveBeenCalledWith(chapter.id, { name: "Renamed Chapter" });
    expect(chapters.delete).toHaveBeenCalledWith(chapter.id);
  });

  test("[REQ-F-012] rejects Chapter creation for a missing parent Book", async () => {
    const { service, books, chapters } = createHarness();
    books.findById.mockResolvedValue(null);

    await expect(service.createChapter("missing-book", { name: "Chapter" })).rejects.toThrow();

    expect(chapters.create).not.toHaveBeenCalled();
  });

  test("[REQ-F-012, REQ-NF-005] deleting a Chapter detaches its relationships and preserves Entries", async () => {
    const { service, entries, entryChapters } = createHarness();

    await service.deleteChapter("chapter-1");

    expect(entryChapters.detachChapter).toHaveBeenCalledWith("chapter-1");
    expect(entries.delete).not.toHaveBeenCalled();
    await expect(entries.findById("entry-1")).resolves.toMatchObject({
      id: "entry-1",
      content: "An idea",
    });
  });

  test("[REQ-F-013] creates and removes a direct Book Association", async () => {
    const { service, entryBooks } = createHarness();

    await service.addBookAssociation("entry-1", "book-1");
    expect(entryBooks.add).toHaveBeenCalledWith("entry-1", "book-1", "direct");

    await service.removeBookAssociation("entry-1", "book-1");
    expect(entryBooks.remove).toHaveBeenCalledWith("entry-1", "book-1", "direct");
  });

  test("[REQ-F-014] allows one Entry to be associated with multiple Books", async () => {
    const { service, entries, entryBooks } = createHarness();
    entryBooks.listForBook.mockResolvedValue([{ entryId: "entry-1" }]);

    await service.addBookAssociation("entry-1", "book-1");
    await service.addBookAssociation("entry-1", "book-2");

    expect(entryBooks.add).toHaveBeenNthCalledWith(1, "entry-1", "book-1", "direct");
    expect(entryBooks.add).toHaveBeenNthCalledWith(2, "entry-1", "book-2", "direct");
    await expect(service.listEntriesForBook("book-1")).resolves.toContainEqual(
      expect.objectContaining({ id: "entry-1" }),
    );
    await expect(service.listEntriesForBook("book-2")).resolves.toContainEqual(
      expect.objectContaining({ id: "entry-1" }),
    );
    expect(entries.findById).toHaveBeenCalledWith("entry-1");
  });

  test("[REQ-F-013, REQ-NF-005] rejects associations to missing records", async () => {
    const { service, books, entryBooks, chapters, entryChapters } = createHarness();
    books.findById.mockResolvedValue(null);
    chapters.findById.mockResolvedValue(null);

    await expect(service.addBookAssociation("entry-1", "missing-book")).rejects.toThrow();
    await expect(service.addChapterAssociation("entry-1", "missing-chapter")).rejects.toThrow();

    expect(entryBooks.add).not.toHaveBeenCalled();
    expect(entryChapters.add).not.toHaveBeenCalled();
  });

  test("[REQ-F-015] creates and removes a Chapter Association", async () => {
    const { service, entryChapters, entryBooks } = createHarness();
    entryChapters.listForEntry.mockResolvedValue([
      { id: "chapter-1", bookId: "book-1", name: "Chapter One" },
    ]);

    await service.addChapterAssociation("entry-1", "chapter-1");
    expect(entryChapters.add).toHaveBeenCalledWith("entry-1", "chapter-1");
    await expect(service.listChaptersForEntry("entry-1")).resolves.toContainEqual(
      expect.objectContaining({ id: "chapter-1" }),
    );

    await service.removeChapterAssociation("entry-1", "chapter-1");
    expect(entryChapters.remove).toHaveBeenCalledWith("entry-1", "chapter-1");
    expect(entryBooks.remove).toHaveBeenCalledWith("entry-1", "book-1", "chapter-derived");
  });

  test("[REQ-F-016] Chapter Association creates a distinct derived parent Book Association", async () => {
    const { service, entryBooks, entryChapters } = createHarness();
    entryBooks.listForEntry.mockResolvedValue([
      { bookId: "book-1", source: "direct" },
    ]);

    await service.addChapterAssociation("entry-1", "chapter-1");

    expect(entryChapters.add).toHaveBeenCalledWith("entry-1", "chapter-1");
    expect(entryBooks.add).toHaveBeenCalledWith("entry-1", "book-1", "chapter-derived");
  });

  test("[REQ-F-016, REQ-NF-005] removing a Chapter Association preserves a direct Book Association", async () => {
    const { service, entryBooks } = createHarness();
    entryBooks.listForEntry.mockResolvedValue([
      { bookId: "book-1", source: "direct" },
      { bookId: "book-1", source: "chapter-derived" },
    ]);

    await service.removeChapterAssociation("entry-1", "chapter-1");

    expect(entryBooks.remove).toHaveBeenCalledWith("entry-1", "book-1", "chapter-derived");
    expect(entryBooks.remove).not.toHaveBeenCalledWith("entry-1", "book-1", "direct");
  });

  test("[REQ-NF-012] records Book, Chapter, and association events in ISO-8601 UTC", async () => {
    const { service, auditLog } = createHarness();

    const book = await service.createBook({ name: "Audited Book" });
    await service.updateBook(book.id, { name: "Updated Book" });
    const chapter = await service.createChapter(book.id, { name: "Audited Chapter" });
    await service.updateChapter(chapter.id, { name: "Updated Chapter" });
    await service.addBookAssociation("entry-1", book.id);
    await service.addChapterAssociation("entry-1", chapter.id);
    await service.addTagToEntry("entry-1", "tag-1");
    await service.removeTagFromEntry("entry-1", "tag-1");
    await service.removeBookAssociation("entry-1", book.id);
    await service.removeChapterAssociation("entry-1", chapter.id);
    await service.deleteChapter(chapter.id);
    await service.deleteBook(book.id);

    const events = auditLog.record.mock.calls.map(([record]) => record);
    expect(events.map(({ event }) => event)).toEqual([
      "book.create",
      "book.update",
      "chapter.create",
      "chapter.update",
      "entry.book-association.add",
      "entry.chapter-association.add",
      "entry.tag.add",
      "entry.tag.remove",
      "entry.book-association.remove",
      "entry.chapter-association.remove",
      "chapter.delete",
      "book.delete",
    ]);
    for (const event of events) {
      expect(event.occurredAt).toBe("2026-01-02T03:04:05.000Z");
    }
  });

  test.todo("[REQ-NF-012] rotates the device-local audit log at 2 MB by removing oldest records first");
});
