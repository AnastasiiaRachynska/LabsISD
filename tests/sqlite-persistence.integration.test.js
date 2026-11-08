"use strict";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const supportsNodeSqlite = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5);
const sqliteTest = supportsNodeSqlite ? test : test.skip;

sqliteTest("persists application workflows in a real SQLite database", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { DatabaseSync } = require("node:sqlite");
  const { createApplication } = require("../src/bootstrap/create-application");
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "labsisd-sqlite-"));
  const databasePath = path.join(temporaryDirectory, "application.db");
  const connections = [];
  function openDatabase() {
    const rawDatabase = new DatabaseSync(databasePath);
    let closed = false;
    connections.push({
      close() {
        if (!closed) {
          rawDatabase.close();
          closed = true;
        }
      },
    });
    return {
      execAsync: async (sql) => rawDatabase.exec(sql),
      runAsync: async (sql, ...parameters) => rawDatabase.prepare(sql).run(...parameters),
      getFirstAsync: async (sql, ...parameters) =>
        rawDatabase.prepare(sql).get(...parameters) ?? null,
      getAllAsync: async (sql, ...parameters) =>
        rawDatabase.prepare(sql).all(...parameters),
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
  };

  try {
    let nextId = 0;
    const application = await createApplication({
      openDatabase: async () => openDatabase(),
      createId: () => `record-${++nextId}`,
    });
    let book = await application.bookOrganization.createBook({ name: "Novel" });
    book = await application.bookOrganization.updateBook(book.id, { name: "Revised Novel" });
    const chapter = await application.bookOrganization.createChapter(book.id, {
      name: "Opening",
    });
    await application.bookOrganization.updateChapter(chapter.id, { name: "Revised Opening" });
    const tag = await application.repositories.tags.create({
      id: "tag-1",
      name: "Draft",
    });
    await application.repositories.tags.update(tag.id, { name: "Work in Progress" });
    const firstEntry = await application.entryCapture.createEntry({
      content: "A local note",
      tags: [tag.id],
      chapterAssociations: [chapter.id],
    });

    await application.bookOrganization.addBookAssociation(firstEntry.id, book.id);
    const secondBook = await application.bookOrganization.createBook({ name: "Short Stories" });
    await application.bookOrganization.addBookAssociation(firstEntry.id, secondBook.id);
    const secondEntry = await application.entryCapture.createEntry({
      content: "A linked note",
    });
    await application.entryRelationships.addEntryLink(firstEntry.id, secondEntry.id);
    expect((await application.entryCapture.getEntry(firstEntry.id)).entryLinks).toEqual([
      secondEntry.id,
    ]);

    await application.bookOrganization.deleteChapter(chapter.id);
    const afterChapterDeletion = await application.entryCapture.getEntry(firstEntry.id);
    expect(afterChapterDeletion.chapterAssociations).toEqual([]);
    expect(afterChapterDeletion.bookAssociations).toEqual([
      { bookId: book.id, source: "direct" },
      { bookId: secondBook.id, source: "direct" },
    ]);

    await application.bookOrganization.deleteBook(book.id);
    const afterBookDeletion = await application.entryCapture.getEntry(firstEntry.id);
    expect(afterBookDeletion).toMatchObject({
      id: firstEntry.id,
      content: "A local note",
      tags: [tag.id],
    });
    expect(afterBookDeletion.bookAssociations).toEqual([
      { bookId: secondBook.id, source: "direct" },
    ]);
    await application.bookOrganization.deleteBook(secondBook.id);
    expect((await application.entryCapture.getEntry(firstEntry.id)).bookAssociations).toEqual([]);
    expect(await application.repositories.entryLinks.listForEntry(firstEntry.id)).toEqual([
      { entryId: secondEntry.id },
    ]);

    await application.repositories.entryLinks.remove(firstEntry.id, secondEntry.id);
    expect(await application.entryCapture.getEntry(firstEntry.id)).not.toBeNull();
    expect(await application.entryCapture.getEntry(secondEntry.id)).not.toBeNull();
    expect(await application.repositories.entryLinks.listForEntry(firstEntry.id)).toEqual([]);

    connections[0].close();
    const reopenedApplication = await createApplication({
      openDatabase: async () => openDatabase(),
      createId: () => `reopened-${++nextId}`,
    });
    expect(await reopenedApplication.entryCapture.getEntry(firstEntry.id)).toMatchObject({
      content: "A local note",
      tags: [tag.id],
    });
    expect(await reopenedApplication.repositories.pendingChanges.list()).toHaveLength(6);
    expect(await reopenedApplication.repositories.auditLog.list()).toHaveLength(15);
    expect(await reopenedApplication.repositories.entryLinks.listForEntry(firstEntry.id)).toEqual(
      [],
    );

    await reopenedApplication.entryRelationships.addEntryLink(firstEntry.id, secondEntry.id);
    await reopenedApplication.entryRelationships.deleteEntry(firstEntry.id);

    expect(await reopenedApplication.repositories.entries.findById(firstEntry.id)).toBeNull();
    expect(await reopenedApplication.repositories.entries.findById(secondEntry.id)).toMatchObject({
      id: secondEntry.id,
      content: "A linked note",
    });
    expect(
      await reopenedApplication.repositories.entryLinks.listForEntry(secondEntry.id),
    ).toEqual([]);
    expect(await reopenedApplication.repositories.entryTags.listForEntry(firstEntry.id)).toEqual(
      [],
    );
    expect(await reopenedApplication.repositories.entryBooks.listForEntry(firstEntry.id)).toEqual(
      [],
    );
    expect(
      await reopenedApplication.repositories.entryChapters.listForEntry(firstEntry.id),
    ).toEqual([]);
  } finally {
    for (const connection of connections) {
      connection.close();
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
