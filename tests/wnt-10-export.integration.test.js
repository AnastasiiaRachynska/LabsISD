"use strict";

const nodeVersion = process.versions.node.split(".").map(Number);
const supportsNodeSqlite = nodeVersion[0] > 22 || (nodeVersion[0] === 22 && nodeVersion[1] >= 5);
const sqliteTest = supportsNodeSqlite ? test : test.skip;

sqliteTest("exports real SQLite Book data to a UTF-8 text file", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { DatabaseSync } = require("node:sqlite");
  const { initializeLocalDatabase } = require("../src/bootstrap/local-database");
  const { createSqliteRepositories } = require("../src/bootstrap/sqlite-repositories");
  const { createExportService } = require("../src/wnt10/export");
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "labsisd-export-"));
  const rawDatabase = new DatabaseSync(path.join(temporaryDirectory, "export.db"));
  const database = {
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

  try {
    await initializeLocalDatabase(database);
    const repositories = createSqliteRepositories(database);
    const book = await repositories.books.create({ id: "book-1", name: "A Novel" });
    const chapter = await repositories.chapters.create({
      id: "chapter-1",
      bookId: book.id,
      name: "Chapter One",
    });
    await repositories.entries.create({
      id: "chapter-entry",
      content: "Résumé and 東京.",
      title: null,
      displayTitle: "Résumé and 東京.",
      entryType: "General Note",
      tags: [],
      bookAssociations: [{ bookId: book.id, source: "direct" }],
      chapterAssociations: [chapter.id],
      entryLinks: [],
    });
    await repositories.entries.create({
      id: "general-entry",
      content: "General book note.",
      title: null,
      displayTitle: "General book note.",
      entryType: "General Note",
      tags: [],
      bookAssociations: [book.id],
      chapterAssociations: [],
      entryLinks: [],
    });

    const fileStorage = {
      async writeTextFile({ fileName, contents, encoding }) {
        const filePath = path.join(temporaryDirectory, fileName);
        fs.writeFileSync(filePath, contents, { encoding });
        return { uri: filePath };
      },
    };
    const service = createExportService({
      entries: repositories.entries,
      books: repositories.books,
      chapters: repositories.chapters,
      entryBooks: repositories.entryBooks,
      entryChapters: repositories.entryChapters,
      fileStorage,
      auditLog: repositories.auditLog,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    const result = await service.exportBook(book.id);
    const exportedText = fs.readFileSync(result.uri, "utf8");

    expect(path.extname(result.uri)).toBe(".txt");
    expect(exportedText).toContain("Résumé and 東京.");
    expect(exportedText).toContain("Chapter One");
    expect(exportedText).toContain("General Book Notes");
    expect(exportedText).toContain("General book note.");
    expect(exportedText.indexOf("Résumé and 東京.")).toBeLessThan(
      exportedText.indexOf("General Book Notes"),
    );
    expect(exportedText.indexOf("General book note.")).toBeGreaterThan(
      exportedText.indexOf("General Book Notes"),
    );
  } finally {
    rawDatabase.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
