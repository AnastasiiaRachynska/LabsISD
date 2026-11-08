"use strict";

const AUDIT_LOG_MAX_BYTES = 2 * 1024 * 1024;
const ENTRY_TYPES = new Set([
  "Character",
  "Scene",
  "Plot Idea",
  "World-building",
  "Dialogue/Phrase",
  "General Note",
]);

function requireDatabase(database) {
  const methods = ["runAsync", "getFirstAsync", "getAllAsync", "withTransactionAsync"];
  if (!database || methods.some((method) => typeof database[method] !== "function")) {
    throw new TypeError("SQLite repositories require a valid Expo SQLite database.");
  }
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

function requireNonblankString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a nonblank string.`);
  }
}

function requireRecord(record, kind, id) {
  if (!record) {
    throw new Error(`${kind} ${id} was not found.`);
  }
  return record;
}

function toId(value, field) {
  const id = typeof value === "string" ? value : value && (value.id || value[`${field}Id`]);
  requireNonblankString(id, field);
  return id;
}

function mapBook(row) {
  return row ? { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function mapChapter(row) {
  return row
    ? {
        id: row.id,
        bookId: row.book_id,
        name: row.name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

function mapTag(row) {
  return row ? { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function createSqliteRepositories(database, { now = () => new Date() } = {}) {
  requireDatabase(database);
  if (typeof now !== "function") {
    throw new TypeError("A clock function is required for SQLite repositories.");
  }

  const entries = {};
  const tags = {
    async create(tag) {
      requireNonblankString(tag && tag.id, "Tag ID");
      requireNonblankString(tag && tag.name, "Tag name");
      await database.runAsync("INSERT INTO tags (id, name) VALUES (?, ?);", tag.id, tag.name);
      return this.findById(tag.id);
    },
    async findById(id) {
      return mapTag(await database.getFirstAsync("SELECT * FROM tags WHERE id = ?;", id));
    },
    async update(id, changes) {
      requireNonblankString(changes && changes.name, "Tag name");
      const result = await database.runAsync(
        "UPDATE tags SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?;",
        changes.name,
        id,
      );
      return result.changes ? this.findById(id) : null;
    },
    async delete(id) {
      const result = await database.runAsync("DELETE FROM tags WHERE id = ?;", id);
      return result.changes > 0;
    },
    async list() {
      return (await database.getAllAsync("SELECT * FROM tags ORDER BY name COLLATE NOCASE;")).map(mapTag);
    },
  };

  const books = createNamedRepository(database, "books", "Book", mapBook);
  const chapters = {
    ...createNamedRepository(database, "chapters", "Chapter", mapChapter),
    async listByBookId(bookId) {
      return (
        await database.getAllAsync(
          "SELECT * FROM chapters WHERE book_id = ? ORDER BY created_at, id;",
          bookId,
        )
      ).map(mapChapter);
    },
  };

  const entryTags = {
    async add(entryId, tagId) {
      await database.runAsync(
        "INSERT OR IGNORE INTO entry_tags (entry_id, tag_id) VALUES (?, ?);",
        entryId,
        tagId,
      );
    },
    async remove(entryId, tagId) {
      await database.runAsync(
        "DELETE FROM entry_tags WHERE entry_id = ? AND tag_id = ?;",
        entryId,
        tagId,
      );
    },
    async listForEntry(entryId) {
      return (
        await database.getAllAsync(
          `SELECT tags.* FROM tags
           INNER JOIN entry_tags ON entry_tags.tag_id = tags.id
           WHERE entry_tags.entry_id = ?
           ORDER BY tags.name COLLATE NOCASE;`,
          entryId,
        )
      ).map(mapTag);
    },
    async replaceForEntry(entryId, tagIds) {
      await database.runAsync("DELETE FROM entry_tags WHERE entry_id = ?;", entryId);
      for (const tagId of tagIds) {
        await this.add(entryId, tagId);
      }
    },
  };

  const entryBooks = {
    async add(entryId, bookId, source = "direct") {
      validateAssociationSource(source);
      await database.runAsync(
        "INSERT OR IGNORE INTO entry_books (entry_id, book_id, source) VALUES (?, ?, ?);",
        entryId,
        bookId,
        source,
      );
    },
    async remove(entryId, bookId, source = "direct") {
      validateAssociationSource(source);
      await database.runAsync(
        "DELETE FROM entry_books WHERE entry_id = ? AND book_id = ? AND source = ?;",
        entryId,
        bookId,
        source,
      );
    },
    async listForEntry(entryId) {
      return (
        await database.getAllAsync(
          "SELECT book_id AS bookId, source FROM entry_books WHERE entry_id = ? ORDER BY book_id, source;",
          entryId,
        )
      );
    },
    async listForBook(bookId) {
      return (
        await database.getAllAsync(
          "SELECT entry_id AS entryId, source FROM entry_books WHERE book_id = ? ORDER BY entry_id, source;",
          bookId,
        )
      );
    },
    async detachBook(bookId) {
      await database.runAsync("DELETE FROM entry_books WHERE book_id = ?;", bookId);
    },
    async replaceDirectForEntry(entryId, associations) {
      await database.runAsync(
        "DELETE FROM entry_books WHERE entry_id = ? AND source = 'direct';",
        entryId,
      );
      for (const association of associations.filter(
        (item) => typeof item === "string" || !item.source || item.source === "direct",
      )) {
        const bookId = toId(association, "book");
        await this.add(entryId, bookId, "direct");
      }
    },
  };

  const entryChapters = {
    async add(entryId, chapterId) {
      await database.runAsync(
        "INSERT OR IGNORE INTO entry_chapters (entry_id, chapter_id) VALUES (?, ?);",
        entryId,
        chapterId,
      );
    },
    async remove(entryId, chapterId) {
      await database.runAsync(
        "DELETE FROM entry_chapters WHERE entry_id = ? AND chapter_id = ?;",
        entryId,
        chapterId,
      );
    },
    async listForEntry(entryId) {
      return database.getAllAsync(
        `SELECT chapters.id, chapters.id AS chapterId, chapters.book_id AS bookId, chapters.name
         FROM chapters
         INNER JOIN entry_chapters ON entry_chapters.chapter_id = chapters.id
         WHERE entry_chapters.entry_id = ?
         ORDER BY chapters.created_at, chapters.id;`,
        entryId,
      );
    },
    async detachChapter(chapterId) {
      await database.withTransactionAsync(async () => {
        const chapter = await database.getFirstAsync(
          "SELECT book_id FROM chapters WHERE id = ?;",
          chapterId,
        );
        if (!chapter) {
          return;
        }

        const affectedEntries = await database.getAllAsync(
          "SELECT entry_id FROM entry_chapters WHERE chapter_id = ?;",
          chapterId,
        );
        await database.runAsync("DELETE FROM entry_chapters WHERE chapter_id = ?;", chapterId);

        for (const { entry_id: entryId } of affectedEntries) {
          const remaining = await database.getFirstAsync(
            `SELECT 1 AS found
             FROM entry_chapters
             INNER JOIN chapters ON chapters.id = entry_chapters.chapter_id
             WHERE entry_chapters.entry_id = ? AND chapters.book_id = ?
             LIMIT 1;`,
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
      });
    },
  };

  const entryLinks = {
    async add(entryId, linkedEntryId) {
      const [firstId, secondId] = orderPair(entryId, linkedEntryId);
      await database.runAsync(
        "INSERT OR IGNORE INTO entry_links (entry_id, linked_entry_id) VALUES (?, ?);",
        firstId,
        secondId,
      );
    },
    async remove(entryId, linkedEntryId) {
      const [firstId, secondId] = orderPair(entryId, linkedEntryId);
      await database.runAsync(
        "DELETE FROM entry_links WHERE entry_id = ? AND linked_entry_id = ?;",
        firstId,
        secondId,
      );
    },
    async listForEntry(entryId) {
      return database.getAllAsync(
        `SELECT CASE WHEN entry_id = ? THEN linked_entry_id ELSE entry_id END AS entryId
         FROM entry_links
         WHERE entry_id = ? OR linked_entry_id = ?
         ORDER BY entryId;`,
        entryId,
        entryId,
        entryId,
      );
    },
    async replaceForEntry(entryId, links) {
      const currentLinks = await this.listForEntry(entryId);
      for (const link of currentLinks) {
        await this.remove(entryId, link.entryId);
      }
      for (const link of links) {
        await this.add(entryId, toId(link, "entry"));
      }
    },
  };

  Object.assign(entries, {
    async create(entry) {
      validateEntry(entry);
      await database.withTransactionAsync(async () => {
        await database.runAsync(
          `INSERT INTO entries (id, content, title, display_title, entry_type)
           VALUES (?, ?, ?, ?, ?);`,
          entry.id,
          entry.content,
          entry.title,
          entry.displayTitle,
          entry.entryType,
        );
        await entryTags.replaceForEntry(entry.id, entry.tags || []);
        await entryBooks.replaceDirectForEntry(entry.id, entry.bookAssociations || []);
        await replaceChapterAssociations(entry.id, entry.chapterAssociations || []);
        await entryLinks.replaceForEntry(entry.id, entry.entryLinks || []);
      });
      return this.findById(entry.id);
    },
    async findById(id) {
      const row = await database.getFirstAsync("SELECT * FROM entries WHERE id = ?;", id);
      return row ? mapEntry(row, entryTags, entryBooks, entryChapters, entryLinks) : null;
    },
    async update(id, changes) {
      const current = await database.getFirstAsync("SELECT * FROM entries WHERE id = ?;", id);
      if (!current) {
        return null;
      }
      validateEntryChanges(changes);
      await database.withTransactionAsync(async () => {
        const nextContent = changes.content === undefined ? current.content : changes.content;
        const nextTitle = changes.title === undefined ? current.title : changes.title;
        const nextDisplayTitle =
          changes.displayTitle === undefined
            ? deriveDisplayTitle(nextContent, nextTitle)
            : changes.displayTitle;
        const nextEntryType = changes.entryType === undefined ? current.entry_type : changes.entryType;

        await database.runAsync(
          `UPDATE entries
           SET content = ?, title = ?, display_title = ?, entry_type = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?;`,
          nextContent,
          nextTitle,
          nextDisplayTitle,
          nextEntryType,
          id,
        );
        if (Object.prototype.hasOwnProperty.call(changes, "tags")) {
          await entryTags.replaceForEntry(id, changes.tags);
        }
        if (Object.prototype.hasOwnProperty.call(changes, "bookAssociations")) {
          await entryBooks.replaceDirectForEntry(id, changes.bookAssociations);
        }
        if (Object.prototype.hasOwnProperty.call(changes, "chapterAssociations")) {
          await replaceChapterAssociations(id, changes.chapterAssociations);
        }
        if (Object.prototype.hasOwnProperty.call(changes, "entryLinks")) {
          await entryLinks.replaceForEntry(id, changes.entryLinks);
        }
      });
      return this.findById(id);
    },
    async list() {
      const rows = await database.getAllAsync("SELECT * FROM entries ORDER BY created_at, id;");
      return Promise.all(
        rows.map((row) => mapEntry(row, entryTags, entryBooks, entryChapters, entryLinks)),
      );
    },
    async delete(id) {
      const result = await database.runAsync("DELETE FROM entries WHERE id = ?;", id);
      return result.changes > 0;
    },
  });

  async function replaceChapterAssociations(entryId, chapterIds) {
    const current = await entryChapters.listForEntry(entryId);
    const previousBookIds = new Set(current.map((chapter) => chapter.bookId).filter(Boolean));
    for (const chapter of current) {
      await entryChapters.remove(entryId, chapter.id);
    }
    for (const chapter of chapterIds) {
      const chapterId = toId(chapter, "chapter");
      const record = requireRecord(
        await chapters.findById(chapterId),
        "Chapter",
        chapterId,
      );
      await entryChapters.add(entryId, chapterId);
      await entryBooks.add(entryId, record.bookId, "chapter-derived");
    }
    for (const bookId of previousBookIds) {
      const remaining = await database.getFirstAsync(
        `SELECT 1 AS found
         FROM entry_chapters
         INNER JOIN chapters ON chapters.id = entry_chapters.chapter_id
         WHERE entry_chapters.entry_id = ? AND chapters.book_id = ?
         LIMIT 1;`,
        entryId,
        bookId,
      );
      if (!remaining) {
        await entryBooks.remove(entryId, bookId, "chapter-derived");
      }
    }
  }

  const pendingChanges = {
    async enqueue(change) {
      validatePendingChange(change);
      await database.runAsync(
        `INSERT INTO pending_changes (operation, resource_type, resource_id, payload)
         VALUES (?, ?, ?, ?);`,
        change.operation,
        change.resourceType,
        change.resourceId,
        JSON.stringify(change.payload || {}),
      );
    },
    async list() {
      const rows = await database.getAllAsync("SELECT * FROM pending_changes ORDER BY id;");
      return rows.map((row) => ({
        id: row.id,
        operation: row.operation,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        payload: JSON.parse(row.payload),
        enqueuedAt: row.enqueued_at,
      }));
    },
    async removeThrough(id) {
      await database.runAsync("DELETE FROM pending_changes WHERE id <= ?;", id);
    },
  };

  const auditLog = {
    async record(event) {
      validateAuditEvent(event);
      const payload = JSON.stringify(event);
      await database.withTransactionAsync(async () => {
        await database.runAsync(
          `INSERT INTO diagnostic_events (event, resource_id, occurred_at, payload)
           VALUES (?, ?, ?, ?);`,
          event.event,
          event.resourceId,
          event.occurredAt,
          payload,
        );
        let { totalBytes } = await database.getFirstAsync(
          "SELECT COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS totalBytes FROM diagnostic_events;",
        );
        while (totalBytes > AUDIT_LOG_MAX_BYTES) {
          const oldest = await database.getFirstAsync(
            "SELECT id, length(CAST(payload AS BLOB)) AS bytes FROM diagnostic_events ORDER BY id LIMIT 1;",
          );
          if (!oldest) {
            break;
          }
          await database.runAsync("DELETE FROM diagnostic_events WHERE id = ?;", oldest.id);
          totalBytes -= oldest.bytes;
        }
      });
    },
    async list() {
      const rows = await database.getAllAsync("SELECT payload FROM diagnostic_events ORDER BY id;");
      return rows.map((row) => JSON.parse(row.payload));
    },
  };

  const syncMetadata = {
    async get(key) {
      const row = await database.getFirstAsync("SELECT value FROM sync_metadata WHERE key = ?;", key);
      return row ? row.value : null;
    },
    async set(key, value) {
      requireNonblankString(key, "Sync metadata key");
      if (typeof value !== "string") {
        throw new TypeError("Sync metadata value must be a string.");
      }
      await database.runAsync(
        "INSERT OR REPLACE INTO sync_metadata (key, value) VALUES (?, ?);",
        key,
        value,
      );
    },
  };

  return {
    entries,
    books,
    chapters,
    tags,
    entryTags,
    entryBooks,
    entryChapters,
    entryLinks,
    pendingChanges,
    auditLog,
    syncMetadata,
  };
}

function createNamedRepository(database, table, kind, mapRecord) {
  return {
    async create(record) {
      requireNonblankString(record && record.id, `${kind} ID`);
      requireNonblankString(record && record.name, `${kind} name`);
      const isChapter = table === "chapters";
      const columns = isChapter ? "(id, book_id, name)" : "(id, name)";
      const placeholders = isChapter ? "(?, ?, ?)" : "(?, ?)";
      const values = isChapter
        ? [record.id, record.bookId, record.name]
        : [record.id, record.name];
      await database.runAsync(
        `INSERT INTO ${table} ${columns} VALUES ${placeholders};`,
        ...values,
      );
      return this.findById(record.id);
    },
    async findById(id) {
      return mapRecord(await database.getFirstAsync(`SELECT * FROM ${table} WHERE id = ?;`, id));
    },
    async update(id, changes) {
      requireNonblankString(changes && changes.name, `${kind} name`);
      const result = await database.runAsync(
        `UPDATE ${table}
         SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?;`,
        changes.name,
        id,
      );
      return result.changes ? this.findById(id) : null;
    },
    async delete(id) {
      const result = await database.runAsync(`DELETE FROM ${table} WHERE id = ?;`, id);
      return result.changes > 0;
    },
    async list() {
      return (await database.getAllAsync(`SELECT * FROM ${table} ORDER BY created_at, id;`)).map(mapRecord);
    },
  };
}

async function mapEntry(row, entryTags, entryBooks, entryChapters, entryLinks) {
  const [tags, bookAssociations, chapterAssociations, entryLinksForRecord] = await Promise.all([
    entryTags.listForEntry(row.id),
    entryBooks.listForEntry(row.id),
    entryChapters.listForEntry(row.id),
    entryLinks.listForEntry(row.id),
  ]);
  return {
    id: row.id,
    content: row.content,
    title: row.title,
    displayTitle: row.display_title,
    entryType: row.entry_type,
    tags: tags.map((tag) => tag.id),
    bookAssociations,
    chapterAssociations: chapterAssociations.map((chapter) => chapter.id),
    entryLinks: entryLinksForRecord.map((link) => link.entryId),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateAssociationSource(source) {
  if (source !== "direct" && source !== "chapter-derived") {
    throw new TypeError("Book Association source must be direct or chapter-derived.");
  }
}

function orderPair(firstId, secondId) {
  requireNonblankString(firstId, "Entry ID");
  requireNonblankString(secondId, "Linked Entry ID");
  if (firstId === secondId) {
    throw new TypeError("An Entry cannot be linked to itself.");
  }
  return firstId < secondId ? [firstId, secondId] : [secondId, firstId];
}

function validateEntry(entry) {
  requireNonblankString(entry && entry.id, "Entry ID");
  requireNonblankString(entry && entry.content, "Entry Content");
  requireNonblankString(entry && entry.displayTitle, "Entry Display Title");
  if (!ENTRY_TYPES.has(entry.entryType)) {
    throw new TypeError("Entry Type is not supported.");
  }
}

function validateEntryChanges(changes) {
  const allowedFields = new Set([
    "content",
    "title",
    "displayTitle",
    "entryType",
    "tags",
    "bookAssociations",
    "chapterAssociations",
    "entryLinks",
  ]);
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new TypeError("Entry changes must be an object.");
  }
  if (Object.keys(changes).some((field) => !allowedFields.has(field))) {
    throw new TypeError("Entry changes contain unsupported fields.");
  }
  if (changes.content !== undefined) {
    requireNonblankString(changes.content, "Entry Content");
  }
  if (changes.displayTitle !== undefined) {
    requireNonblankString(changes.displayTitle, "Entry Display Title");
  }
  if (changes.entryType !== undefined && !ENTRY_TYPES.has(changes.entryType)) {
    throw new TypeError("Entry Type is not supported.");
  }
  for (const field of ["tags", "bookAssociations", "chapterAssociations", "entryLinks"]) {
    if (changes[field] !== undefined && !Array.isArray(changes[field])) {
      throw new TypeError(`${field} must be an array.`);
    }
  }
}

function validatePendingChange(change) {
  if (!change || typeof change !== "object") {
    throw new TypeError("Pending change must be an object.");
  }
  if (!["create", "update", "delete"].includes(change.operation)) {
    throw new TypeError("Pending change operation is not supported.");
  }
  requireNonblankString(change.resourceType, "Pending change resource type");
  requireNonblankString(change.resourceId, "Pending change resource ID");
}

function validateAuditEvent(event) {
  if (!event || typeof event !== "object") {
    throw new TypeError("Audit event must be an object.");
  }
  requireNonblankString(event.event, "Audit event name");
  requireNonblankString(event.resourceId, "Audit resource ID");
  const timestamp = new Date(event.occurredAt);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== event.occurredAt) {
    throw new TypeError("Audit event timestamp must be ISO-8601 UTC.");
  }
}

module.exports = {
  AUDIT_LOG_MAX_BYTES,
  createSqliteRepositories,
};
