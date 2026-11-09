"use strict";

const { createEntryCaptureService } = require("../wnt06/entry-capture");
const { createBookOrganizationService } = require("../wnt07/book-organization");
const { createEntryRelationshipService } = require("../wnt08/entry-relationships");
const { createEntrySearchService } = require("../wnt09/entry-search");
const { createExportService } = require("../wnt10/export");
const { createSynchronizationService } = require("../wnt12/synchronization");
const { createExpoFileStorage } = require("./expo-file-storage");
const { initializeLocalDatabase } = require("./local-database");
const { createSqliteRepositories } = require("./sqlite-repositories");
const { createSqliteSyncStore } = require("./sqlite-sync-store");

/**
 * @param {object} options
 * @param {() => Promise<import("expo-sqlite").SQLiteDatabase>} options.openDatabase
 * @param {() => string} options.createId
 * @param {() => Date} [options.now]
 * @param {{
 *   pushChanges: (payload: object, options: { idempotencyKey: string }) => Promise<{ status: number, body?: object }>,
 *   pullChanges: (cursor?: string | null) => Promise<{ status: number, body?: object }>
 * }} [options.syncApi]
 */
async function createApplication({
  openDatabase,
  createId,
  now = () => new Date(),
  fileStorage,
  syncApi,
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
  const tagRepository = repositories.tags;
  repositories.tags = {
    ...tagRepository,
    async create(tag) {
      const savedTag = await tagRepository.create(tag);
      await repositories.pendingChanges.enqueue({
        operation: "create",
        resourceType: "tag",
        resourceId: savedTag.id,
        payload: savedTag,
      });
      await repositories.auditLog.record({
        event: "tag.create",
        resourceId: savedTag.id,
        occurredAt: now().toISOString(),
      });
      return savedTag;
    },
    async update(id, changes) {
      const updatedTag = await tagRepository.update(id, changes);
      if (updatedTag) {
        await repositories.pendingChanges.enqueue({
          operation: "update",
          resourceType: "tag",
          resourceId: id,
          payload: updatedTag,
        });
        await repositories.auditLog.record({
          event: "tag.update",
          resourceId: id,
          occurredAt: now().toISOString(),
        });
      }
      return updatedTag;
    },
    async delete(id) {
      const existingTag = await tagRepository.findById(id);
      const deleted = await tagRepository.delete(id);
      if (deleted && existingTag) {
        await repositories.pendingChanges.enqueue({
          operation: "delete",
          resourceType: "tag",
          resourceId: id,
          payload: existingTag,
        });
        await repositories.auditLog.record({
          event: "tag.delete",
          resourceId: id,
          occurredAt: now().toISOString(),
        });
      }
      return deleted;
    },
  };
  if (
    syncApi !== undefined &&
    (!syncApi || typeof syncApi.pushChanges !== "function" ||
      typeof syncApi.pullChanges !== "function")
  ) {
    throw new TypeError("Application sync API must implement pushChanges and pullChanges.");
  }
  const synchronization = syncApi
    ? createSynchronizationService({
        pendingChanges: repositories.pendingChanges,
        syncMetadata: repositories.syncMetadata,
        syncApi,
        localStore: createSqliteSyncStore(database),
        conflicts: repositories.conflicts,
        createId,
        auditLog: repositories.auditLog,
        now,
      })
    : null;
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
    synchronization,
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
      pendingChanges: repositories.pendingChanges,
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
