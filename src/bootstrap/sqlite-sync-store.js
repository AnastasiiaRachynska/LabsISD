"use strict";

const ENTRY_TYPES = new Set([
  "Character",
  "Scene",
  "Plot Idea",
  "World-building",
  "Dialogue/Phrase",
  "General Note",
]);
const SYNC_RESOURCE_TYPES = new Set([
  "entry",
  "book",
  "chapter",
  "tag",
  "entryTagAssociation",
  "entryBookAssociation",
  "entryChapterAssociation",
  "entryLink",
]);

function requireRecord(change) {
  const resource = change.resource;
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    throw new TypeError("Remote resource change requires an object resource.");
  }
  return resource;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Remote ${label} must be a nonblank string.`);
  }
  return value;
}

function deriveDisplayTitle(content, title) {
  if (typeof title === "string" && title.trim().length > 0) {
    return title;
  }
  const first25Characters = content.slice(0, 25);
  const newlineIndex = first25Characters.indexOf("\n");
  if (newlineIndex !== -1) {
    return `${first25Characters.slice(0, newlineIndex)}...`;
  }
  return content.length > 25 ? `${first25Characters}...` : first25Characters;
}

function associationLocalId(resourceType, details) {
  let ids;
  if (resourceType === "entryTagAssociation") {
    ids = [details.entryId, details.tagId];
  } else if (resourceType === "entryBookAssociation") {
    ids = [details.entryId, details.bookId];
  } else if (resourceType === "entryChapterAssociation") {
    ids = [details.entryId, details.chapterId];
  } else {
    ids = [...details.entryIds].sort();
  }
  return `${resourceType}:${JSON.stringify(ids)}`;
}

function createSqliteSyncStore(database) {
  if (!database || typeof database.runAsync !== "function" ||
      typeof database.getFirstAsync !== "function" ||
      typeof database.withTransactionAsync !== "function") {
    throw new TypeError("SQLite sync store requires a valid database connection.");
  }

  async function getLocalResourceId(resourceType, remoteId) {
    const row = await database.getFirstAsync(
      `SELECT local_id FROM sync_resource_ids
       WHERE resource_type = ? AND remote_id = ?;`,
      resourceType,
      remoteId,
    );
    return row ? row.local_id : remoteId;
  }

  async function getRemoteResourceId(resourceType, localId) {
    const row = await database.getFirstAsync(
      `SELECT remote_id FROM sync_resource_ids
       WHERE resource_type = ? AND local_id = ?;`,
      resourceType,
      localId,
    );
    if (!row) {
      throw new Error(`Local ${resourceType} ${localId} has not been synchronized yet.`);
    }
    return row.remote_id;
  }

  async function rememberRemoteResourceId(resourceType, localId, remoteId) {
    requireString(resourceType, "resource type");
    requireString(localId, "local resource ID");
    requireString(remoteId, "remote resource ID");
    await database.runAsync(
      `INSERT INTO sync_resource_ids (resource_type, local_id, remote_id)
       VALUES (?, ?, ?)
       ON CONFLICT(resource_type, local_id) DO UPDATE SET remote_id = excluded.remote_id;`,
      resourceType,
      localId,
      remoteId,
    );
  }

  async function rememberRemoteId(resourceType, remoteId, details) {
    await database.runAsync(
      `INSERT OR REPLACE INTO sync_remote_ids (resource_type, remote_id, local_details)
       VALUES (?, ?, ?);`,
      resourceType,
      remoteId,
      JSON.stringify(details),
    );
  }

  async function applyAssociation(change) {
    const { resourceType, resourceId, operation } = change;
    if (operation === "delete") {
      const row = await database.getFirstAsync(
        `SELECT local_details FROM sync_remote_ids
         WHERE resource_type = ? AND remote_id = ?;`,
        resourceType,
        resourceId,
      );
      if (row) {
        const details = JSON.parse(row.local_details);
        if (resourceType === "entryTagAssociation") {
          await database.runAsync(
            "DELETE FROM entry_tags WHERE entry_id = ? AND tag_id = ?;",
            details.entryId,
            details.tagId,
          );
        } else if (resourceType === "entryBookAssociation") {
          await database.runAsync(
            `DELETE FROM entry_books
             WHERE entry_id = ? AND book_id = ? AND source = 'direct';`,
            details.entryId,
            details.bookId,
          );
        } else if (resourceType === "entryChapterAssociation") {
          const chapter = await database.getFirstAsync(
            "SELECT book_id FROM chapters WHERE id = ?;",
            details.chapterId,
          );
          await database.runAsync(
            "DELETE FROM entry_chapters WHERE entry_id = ? AND chapter_id = ?;",
            details.entryId,
            details.chapterId,
          );
          if (chapter) {
            const remaining = await database.getFirstAsync(
              `SELECT 1 AS found FROM entry_chapters
               INNER JOIN chapters ON chapters.id = entry_chapters.chapter_id
               WHERE entry_chapters.entry_id = ? AND chapters.book_id = ? LIMIT 1;`,
              details.entryId,
              chapter.book_id,
            );
            if (!remaining) {
              await database.runAsync(
                `DELETE FROM entry_books
                 WHERE entry_id = ? AND book_id = ? AND source = 'chapter-derived';`,
                details.entryId,
                chapter.book_id,
              );
            }
          }
        } else {
          const [first, second] = details.entryIds.sort();
          await database.runAsync(
            "DELETE FROM entry_links WHERE entry_id = ? AND linked_entry_id = ?;",
            first,
            second,
          );
        }
      }
      await database.runAsync(
        "DELETE FROM sync_remote_ids WHERE resource_type = ? AND remote_id = ?;",
        resourceType,
        resourceId,
      );
      await database.runAsync(
        "DELETE FROM sync_resource_ids WHERE resource_type = ? AND remote_id = ?;",
        resourceType,
        resourceId,
      );
      return;
    }

    const resource = requireRecord(change);
    const details = { ...resource };
    if (resourceType === "entryTagAssociation") {
      details.entryId = await getLocalResourceId(
        "entry",
        requireString(resource.entryId, "entryId"),
      );
      details.tagId = await getLocalResourceId(
        "tag",
        requireString(resource.tagId, "tagId"),
      );
      await database.runAsync(
        "INSERT OR IGNORE INTO entry_tags (entry_id, tag_id) VALUES (?, ?);",
        details.entryId,
        details.tagId,
      );
    } else if (resourceType === "entryBookAssociation") {
      details.entryId = await getLocalResourceId(
        "entry",
        requireString(resource.entryId, "entryId"),
      );
      details.bookId = await getLocalResourceId(
        "book",
        requireString(resource.bookId, "bookId"),
      );
      await database.runAsync(
        `INSERT OR IGNORE INTO entry_books (entry_id, book_id, source)
         VALUES (?, ?, 'direct');`,
        details.entryId,
        details.bookId,
      );
    } else if (resourceType === "entryChapterAssociation") {
      details.entryId = await getLocalResourceId(
        "entry",
        requireString(resource.entryId, "entryId"),
      );
      details.chapterId = await getLocalResourceId(
        "chapter",
        requireString(resource.chapterId, "chapterId"),
      );
      const chapter = await database.getFirstAsync(
        "SELECT book_id FROM chapters WHERE id = ?;",
        details.chapterId,
      );
      if (!chapter) {
        throw new Error(`Remote Chapter ${resource.chapterId} was not found locally.`);
      }
      await database.runAsync(
        "INSERT OR IGNORE INTO entry_chapters (entry_id, chapter_id) VALUES (?, ?);",
        details.entryId,
        details.chapterId,
      );
      await database.runAsync(
        `INSERT OR IGNORE INTO entry_books (entry_id, book_id, source)
         VALUES (?, ?, 'chapter-derived');`,
        details.entryId,
        chapter.book_id,
      );
    } else {
      const ids = resource.entryIds;
      if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1]) {
        throw new TypeError("Remote Entry Link must contain two distinct Entry IDs.");
      }
      details.entryIds = await Promise.all(
        ids.map((id) => getLocalResourceId("entry", id)),
      );
      const [first, second] = [...details.entryIds].sort();
      await database.runAsync(
        "INSERT OR IGNORE INTO entry_links (entry_id, linked_entry_id) VALUES (?, ?);",
        first,
        second,
      );
    }
    await rememberRemoteId(resourceType, resourceId, details);
    await rememberRemoteResourceId(
      resourceType,
      associationLocalId(resourceType, details),
      resourceId,
    );
  }

  async function applyRemoteChange(change) {
    if (
      !change ||
      typeof change !== "object" ||
      !["create", "update", "delete"].includes(change.operation) ||
      typeof change.resourceId !== "string" ||
      !SYNC_RESOURCE_TYPES.has(change.resourceType)
    ) {
      throw new TypeError("Remote change is invalid.");
    }
    const { resourceType, resourceId, operation } = change;
    if (resourceType.endsWith("Association") || resourceType === "entryLink") {
      return applyAssociation(change);
    }
    if (operation === "delete") {
      const tableByType = { entry: "entries", book: "books", chapter: "chapters", tag: "tags" };
      const table = tableByType[resourceType];
      if (!table) {
        throw new TypeError(`Unsupported remote resource type ${resourceType}.`);
      }
      if (resourceType === "chapter") {
        const localId = await getLocalResourceId(resourceType, resourceId);
        const chapter = await database.getFirstAsync(
          "SELECT book_id FROM chapters WHERE id = ?;",
          localId,
        );
        if (chapter) {
          const affectedEntries = await database.getAllAsync(
            "SELECT entry_id FROM entry_chapters WHERE chapter_id = ?;",
            localId,
          );
          await database.runAsync("DELETE FROM chapters WHERE id = ?;", localId);
          for (const { entry_id: entryId } of affectedEntries) {
            const remaining = await database.getFirstAsync(
              `SELECT 1 AS found FROM entry_chapters
               INNER JOIN chapters ON chapters.id = entry_chapters.chapter_id
               WHERE entry_chapters.entry_id = ? AND chapters.book_id = ? LIMIT 1;`,
              entryId,
              chapter.book_id,
            );
            if (!remaining) {
              await database.runAsync(
                `DELETE FROM entry_books
                 WHERE entry_id = ? AND book_id = ? AND source = 'chapter-derived';`,
                entryId,
                chapter.book_id,
              );
            }
          }
          await database.runAsync(
            "DELETE FROM sync_resource_ids WHERE resource_type = ? AND remote_id = ?;",
            resourceType,
            resourceId,
          );
          return;
        }
      }
      const localId = await getLocalResourceId(resourceType, resourceId);
      await database.runAsync(`DELETE FROM ${table} WHERE id = ?;`, localId);
      await database.runAsync(
        "DELETE FROM sync_resource_ids WHERE resource_type = ? AND remote_id = ?;",
        resourceType,
        resourceId,
      );
      return;
    }

    const resource = requireRecord(change);
    const id = await getLocalResourceId(resourceType, resourceId);
    if (resourceType === "entry") {
      const content = requireString(resource.content, "Entry content");
      const title = resource.title ?? null;
      const entryType = resource.entryType || "General Note";
      if (!ENTRY_TYPES.has(entryType)) {
        throw new TypeError("Remote Entry type is not supported.");
      }
      await database.runAsync(
        `INSERT INTO entries (id, content, title, display_title, entry_type)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           content = excluded.content,
           title = excluded.title,
           display_title = excluded.display_title,
           entry_type = excluded.entry_type,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');`,
        id,
        content,
        title,
        deriveDisplayTitle(content, title),
        entryType,
      );
    } else if (resourceType === "book" || resourceType === "tag") {
      const table = resourceType === "book" ? "books" : "tags";
      const name = requireString(
        resourceType === "book" ? resource.name || resource.title : resource.name,
        `${resourceType} name`,
      );
      await database.runAsync(
        `INSERT INTO ${table} (id, name) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');`,
        id,
        name,
      );
    } else if (resourceType === "chapter") {
      const bookId = await getLocalResourceId(
        "book",
        requireString(resource.bookId, "Chapter bookId"),
      );
      const name = requireString(resource.name || resource.title, "Chapter name");
      await database.runAsync(
        `INSERT INTO chapters (id, book_id, name) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           book_id = excluded.book_id,
           name = excluded.name,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');`,
        id,
        bookId,
        name,
      );
    } else {
      throw new TypeError(`Unsupported remote resource type ${resourceType}.`);
    }
    await rememberRemoteResourceId(resourceType, id, resourceId);
  }

  return {
    withTransactionAsync(work) {
      if (typeof work !== "function") {
        throw new TypeError("SQLite sync transaction requires a callback.");
      }
      return database.withTransactionAsync(work);
    },
    applyRemoteChange,
    getLocalResourceId,
    getRemoteResourceId,
    rememberRemoteResourceId,
  };
}

module.exports = {
  createSqliteSyncStore,
};
