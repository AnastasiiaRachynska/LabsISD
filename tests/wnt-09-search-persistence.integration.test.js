"use strict";

const nodeVersion = process.versions.node.split(".").map(Number);
const supportsNodeSqlite = nodeVersion[0] > 22 || (nodeVersion[0] === 22 && nodeVersion[1] >= 5);
const sqliteTest = supportsNodeSqlite ? test : test.skip;

sqliteTest("searches persisted Entries and Tags through the composed application", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { DatabaseSync } = require("node:sqlite");
  const { createApplication } = require("../src/bootstrap/create-application");
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "labsisd-search-"));
  const databasePath = path.join(temporaryDirectory, "search.db");
  let rawDatabase;

  try {
    const application = await (async () => {
      rawDatabase = new DatabaseSync(databasePath);
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
      return createApplication({
        openDatabase: async () => database,
        createId: (() => {
          let nextId = 0;
          return () => `search-${++nextId}`;
        })(),
      });
    })();

    await application.repositories.tags.create({ id: "tag-1", name: "Mystery" });
    await application.repositories.tags.create({ id: "tag-2", name: "Character" });
    await application.entryCapture.createEntry({
      content: "A clockwork city at dawn",
      title: "The Mechanical Metropolis",
      entryType: "Scene",
      tags: ["tag-1"],
    });
    await application.entryCapture.createEntry({
      content: "The lost heir returns to the clockwork city",
      entryType: "Plot Idea",
      tags: ["tag-1", "tag-2"],
    });

    await expect(
      application.entrySearch.searchEntries({
        query: "CLOCKWORK CITY",
        entryTypes: ["Plot Idea"],
        tagIds: ["tag-1", "tag-2"],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        content: "The lost heir returns to the clockwork city",
        entryType: "Plot Idea",
        tags: expect.arrayContaining(["tag-1", "tag-2"]),
      }),
    ]);
  } finally {
    if (rawDatabase) {
      rawDatabase.close();
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
