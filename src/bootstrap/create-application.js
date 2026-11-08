"use strict";

const { createEntryCaptureService } = require("../wnt06/entry-capture");
const { createBookOrganizationService } = require("../wnt07/book-organization");
const { createEntryRelationshipService } = require("../wnt08/entry-relationships");
const { createEntrySearchService } = require("../wnt09/entry-search");
const { createExportService } = require("../wnt10/export");
const { createExpoFileStorage } = require("./expo-file-storage");
const { initializeLocalDatabase } = require("./local-database");
const { createSqliteRepositories } = require("./sqlite-repositories");

/**
 * @param {object} options
 * @param {() => Promise<import("expo-sqlite").SQLiteDatabase>} options.openDatabase
 * @param {() => string} options.createId
 * @param {() => Date} [options.now]
 */
async function createApplication({
  openDatabase,
  createId,
  now = () => new Date(),
  fileStorage,
} = {}) {
  if (typeof openDatabase !== "function" || typeof createId !== "function") {
    throw new TypeError("Application startup requires database and ID factories.");
  }
  if (typeof now !== "function") {
    throw new TypeError("Application startup requires a clock function.");
  }

  const database = await openDatabase();
  await initializeLocalDatabase(database);
  const repositories = createSqliteRepositories(database, { now });
  const exportFileStorage = fileStorage || createExpoFileStorage({ createId });
  const serviceDependencies = {
    ...repositories,
    pendingChanges: repositories.pendingChanges,
    auditLog: repositories.auditLog,
    createId,
    now,
  };

  return {
    database,
    repositories,
    entryCapture: createEntryCaptureService({
      entries: repositories.entries,
      pendingChanges: repositories.pendingChanges,
      auditLog: repositories.auditLog,
      createId,
      now,
    }),
    bookOrganization: createBookOrganizationService(serviceDependencies),
    entryRelationships: createEntryRelationshipService({
      entries: repositories.entries,
      entryLinks: repositories.entryLinks,
      auditLog: repositories.auditLog,
      now,
    }),
    entrySearch: createEntrySearchService({
      entries: repositories.entries,
    }),
    exportService: createExportService({
      entries: repositories.entries,
      books: repositories.books,
      chapters: repositories.chapters,
      entryBooks: repositories.entryBooks,
      entryChapters: repositories.entryChapters,
      fileStorage: exportFileStorage,
      auditLog: repositories.auditLog,
      now,
    }),
  };
}

module.exports = {
  createApplication,
};
