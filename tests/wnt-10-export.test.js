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
  ["REQ-F-026", "AC-F-026"],
  ["REQ-F-027", "AC-F-027"],
  ["REQ-F-028", "AC-F-028"],
  ["REQ-F-029", "AC-F-029"],
  ["REQ-NF-003", "AC-NF-003"],
  ["REQ-NF-010", "AC-NF-010"],
  ["REQ-NF-011", "AC-NF-011"],
  ["REQ-NF-012", "AC-NF-012"],
];

const accentedContent = "Café déjà vu — 東京の物語";

function createHarness(overrides = {}) {
  const entries = {
    findById: jest.fn(async (id) => overrides.entryRecords?.[id] || null),
    list: jest.fn(async () => Object.values(overrides.entryRecords || {})),
  };
  const books = {
    findById: jest.fn(async (id) => overrides.bookRecords?.[id] || null),
  };
  const chapters = {
    listByBookId: jest.fn(async () => overrides.chapterRecords || []),
  };
  const entryBooks = {
    listForBook: jest.fn(async () => overrides.bookAssociations || []),
  };
  const entryChapters = {
    listForEntry: jest.fn(async (entryId) => overrides.chapterAssociations?.[entryId] || []),
  };
  const fileStorage = {
    writeTextFile: jest.fn(async ({ fileName }) => ({ uri: `/exports/${fileName}` })),
  };
  const auditLog = { record: jest.fn(async () => undefined) };
  const now = overrides.now || (() => new Date("2026-01-02T03:04:05.000Z"));
  const { createExportService } = require("../src/wnt10/export");

  return {
    entries,
    books,
    chapters,
    entryBooks,
    entryChapters,
    fileStorage,
    auditLog,
    service: createExportService({
      entries,
      books,
      chapters,
      entryBooks,
      entryChapters,
      fileStorage,
      auditLog,
      now,
    }),
  };
}

function sectionIndex(contents, heading) {
  return contents.indexOf(heading);
}

describe("WNT-10 SRS and acceptance-criteria traceability", () => {
  test.each(requirementMap)("%s maps to %s and WNT-10", (requirementId, criterionId) => {
    expect(srs).toContain(requirementId);
    expect(srs).toContain(criterionId);

    const row = traceabilityMatrix
      .split(/\r?\n/)
      .find((line) => line.includes(`${requirementId} & ${criterionId}`));
    expect(row).toContain("WNT-10");
  });
});

describe("WNT-10 Entry and Book exports", () => {
  test("[REQ-F-026, REQ-NF-010] exports Entry Content to a UTF-8 .txt file", async () => {
    const entry = {
      id: "entry-1",
      content: accentedContent,
      title: "Not part of Entry export",
    };
    const { service, entries, fileStorage, auditLog } = createHarness({
      entryRecords: { [entry.id]: entry },
    });

    const result = await service.exportEntry(entry.id);

    expect(entries.findById).toHaveBeenCalledWith(entry.id);
    expect(fileStorage.writeTextFile).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: expect.stringMatching(/\.txt$/),
        contents: accentedContent,
        encoding: "utf8",
      }),
    );
    expect(result).toMatchObject({ uri: expect.stringMatching(/\.txt$/) });
    expect(auditLog.record).toHaveBeenCalledWith({
      event: "entry.export",
      resourceId: entry.id,
      occurredAt: "2026-01-02T03:04:05.000Z",
    });
  });

  test("[REQ-F-026] rejects export when the Entry does not exist", async () => {
    const { service, fileStorage, auditLog } = createHarness();

    await expect(service.exportEntry("missing-entry")).rejects.toThrow();

    expect(fileStorage.writeTextFile).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  test("rejects a blank Entry ID before accessing repositories", async () => {
    const { service, entries, fileStorage } = createHarness();

    await expect(service.exportEntry("  ")).rejects.toThrow("Entry ID");

    expect(entries.findById).not.toHaveBeenCalled();
    expect(fileStorage.writeTextFile).not.toHaveBeenCalled();
  });

  test("[REQ-NF-011] surfaces storage failures without reporting export success", async () => {
    const storageError = new Error("Device storage is unavailable.");
    const { service, fileStorage, auditLog } = createHarness({
      entryRecords: {
        "entry-1": { id: "entry-1", content: accentedContent },
      },
    });
    fileStorage.writeTextFile.mockRejectedValue(storageError);

    await expect(service.exportEntry("entry-1")).rejects.toBe(storageError);

    expect(auditLog.record).not.toHaveBeenCalled();
  });

  test("rejects an invalid clock value without creating an export file", async () => {
    const { service, fileStorage, auditLog } = createHarness({
      entryRecords: {
        "entry-1": { id: "entry-1", content: accentedContent },
      },
      now: () => "not-a-date",
    });

    await expect(service.exportEntry("entry-1")).rejects.toThrow("valid Date");

    expect(fileStorage.writeTextFile).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  test("rejects an invalid file-storage result and does not record an audit success", async () => {
    const { service, fileStorage, auditLog } = createHarness({
      entryRecords: {
        "entry-1": { id: "entry-1", content: accentedContent },
      },
    });
    fileStorage.writeTextFile.mockResolvedValue({ uri: "/exports/incomplete" });

    await expect(service.exportEntry("entry-1")).rejects.toThrow("completed .txt export");

    expect(auditLog.record).not.toHaveBeenCalled();
  });

  test("[REQ-F-027, REQ-F-028, REQ-F-029] exports Chapter entries in position order and direct notes last", async () => {
    const book = { id: "book-1", name: "The Novel" };
    const firstChapter = {
      id: "chapter-first",
      bookId: book.id,
      name: "First Chapter",
      position: 1,
      createdAt: "2026-02-01T00:00:00.000Z",
    };
    const secondChapter = {
      id: "chapter-second",
      bookId: book.id,
      name: "Second Chapter",
      position: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const { service, fileStorage, auditLog } = createHarness({
      bookRecords: { [book.id]: book },
      chapterRecords: [secondChapter, firstChapter],
      bookAssociations: [
        { entryId: "chapter-entry-1", source: "chapter-derived" },
        { entryId: "chapter-entry-2", source: "direct" },
        { entryId: "direct-entry", source: "direct" },
      ],
      chapterAssociations: {
        "chapter-entry-1": [{ id: firstChapter.id, bookId: book.id }],
        "chapter-entry-2": [{ id: secondChapter.id, bookId: book.id }],
        "direct-entry": [],
      },
      entryRecords: {
        "chapter-entry-1": { id: "chapter-entry-1", content: "FIRST-CHAPTER-CONTENT" },
        "chapter-entry-2": { id: "chapter-entry-2", content: "SECOND-CHAPTER-CONTENT" },
        "direct-entry": { id: "direct-entry", content: "DIRECT-BOOK-CONTENT" },
      },
    });

    await service.exportBook(book.id);

    const [{ contents, fileName, encoding }] = fileStorage.writeTextFile.mock.calls[0];
    expect(fileName).toMatch(/\.txt$/);
    expect(encoding).toBe("utf8");
    const firstChapterIndex = sectionIndex(contents, "First Chapter");
    const secondChapterIndex = sectionIndex(contents, "Second Chapter");
    const generalNotesIndex = sectionIndex(contents, "General Book Notes");
    expect(firstChapterIndex).toBeGreaterThanOrEqual(0);
    expect(secondChapterIndex).toBeGreaterThan(firstChapterIndex);
    expect(generalNotesIndex).toBeGreaterThan(secondChapterIndex);
    expect(contents.indexOf("FIRST-CHAPTER-CONTENT")).toBeGreaterThan(firstChapterIndex);
    expect(contents.indexOf("FIRST-CHAPTER-CONTENT")).toBeLessThan(secondChapterIndex);
    expect(contents.indexOf("SECOND-CHAPTER-CONTENT")).toBeGreaterThan(secondChapterIndex);
    expect(contents.indexOf("DIRECT-BOOK-CONTENT")).toBeGreaterThan(generalNotesIndex);
    expect(auditLog.record).toHaveBeenCalledWith({
      event: "book.export",
      resourceId: book.id,
      occurredAt: "2026-01-02T03:04:05.000Z",
    });
  });

  test("[REQ-F-028] falls back to createdAt order when Chapter positions are unavailable", async () => {
    const { service, fileStorage } = createHarness({
      bookRecords: { "book-1": { id: "book-1", name: "The Novel" } },
      chapterRecords: [
        {
          id: "chapter-later",
          bookId: "book-1",
          name: "Later Chapter",
          createdAt: "2026-02-01T00:00:00.000Z",
        },
        {
          id: "chapter-earlier",
          bookId: "book-1",
          name: "Earlier Chapter",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      bookAssociations: [{ entryId: "entry-earlier", source: "chapter-derived" }],
      chapterAssociations: {
        "entry-earlier": [{ id: "chapter-earlier", bookId: "book-1" }],
      },
      entryRecords: {
        "entry-earlier": { id: "entry-earlier", content: "EARLIER-CONTENT" },
      },
    });

    await service.exportBook("book-1");

    const [{ contents }] = fileStorage.writeTextFile.mock.calls[0];
    expect(contents.indexOf("Earlier Chapter")).toBeLessThan(contents.indexOf("Later Chapter"));
  });

  test("[REQ-F-029] includes an Entry linked directly and through a Chapter only once", async () => {
    const content = "UNIQUE-ENTRY-CONTENT";
    const { service, fileStorage } = createHarness({
      bookRecords: { "book-1": { id: "book-1", name: "The Novel" } },
      chapterRecords: [
        {
          id: "chapter-1",
          bookId: "book-1",
          name: "Chapter One",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      bookAssociations: [
        { entryId: "entry-1", source: "direct" },
        { entryId: "entry-1", source: "chapter-derived" },
      ],
      chapterAssociations: {
        "entry-1": [{ id: "chapter-1", bookId: "book-1" }],
      },
      entryRecords: { "entry-1": { id: "entry-1", content } },
    });

    await service.exportBook("book-1");

    const [{ contents }] = fileStorage.writeTextFile.mock.calls[0];
    expect(contents.split(content)).toHaveLength(2);
    expect(contents.indexOf(content)).toBeGreaterThan(contents.indexOf("Chapter One"));
    expect(contents).not.toContain("General Book Notes");
  });

  test("[REQ-F-027] rejects export when the Book does not exist", async () => {
    const { service, fileStorage, auditLog } = createHarness();

    await expect(service.exportBook("missing-book")).rejects.toThrow();

    expect(fileStorage.writeTextFile).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  test("rejects invalid Book repository results instead of writing incomplete content", async () => {
    const { service, chapters, fileStorage, entryBooks } = createHarness({
      bookRecords: { "book-1": { id: "book-1", name: "A Novel" } },
    });
    chapters.listByBookId.mockResolvedValue(null);

    await expect(service.exportBook("book-1")).rejects.toThrow("must return arrays");

    chapters.listByBookId.mockResolvedValue([]);
    entryBooks.listForBook.mockResolvedValue(null);
    await expect(service.exportBook("book-1")).rejects.toThrow("must return arrays");
    expect(fileStorage.writeTextFile).not.toHaveBeenCalled();
  });

  test("rejects an associated Entry that has been removed", async () => {
    const { service, fileStorage } = createHarness({
      bookRecords: { "book-1": { id: "book-1", name: "A Novel" } },
      bookAssociations: [{ entryId: "missing-entry", source: "direct" }],
    });

    await expect(service.exportBook("book-1")).rejects.toThrow("was not found");

    expect(fileStorage.writeTextFile).not.toHaveBeenCalled();
  });

  test("rejects invalid Entry-Chapter repository results", async () => {
    const { service, entryChapters, fileStorage } = createHarness({
      bookRecords: { "book-1": { id: "book-1", name: "A Novel" } },
      bookAssociations: [{ entryId: "entry-1", source: "direct" }],
      entryRecords: { "entry-1": { id: "entry-1", content: "Note" } },
    });
    entryChapters.listForEntry.mockResolvedValue(null);

    await expect(service.exportBook("book-1")).rejects.toThrow("must return an array");

    expect(fileStorage.writeTextFile).not.toHaveBeenCalled();
  });
});
