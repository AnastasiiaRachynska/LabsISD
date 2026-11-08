"use strict";

function requireMethod(dependency, method, label) {
  if (!dependency || typeof dependency[method] !== "function") {
    throw new TypeError(`Export service requires ${label}.${method}().`);
  }
}

function requireNonblankString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a nonblank string.`);
  }
}

function safeFilePart(value) {
  const safePart = value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  return safePart || "export";
}

function compareByCreatedAt(first, second) {
  const dateOrder = String(first.createdAt || "").localeCompare(
    String(second.createdAt || ""),
  );
  return dateOrder || String(first.id).localeCompare(String(second.id));
}

function orderChapters(chapterRecords) {
  const chapters = [...chapterRecords];
  const hasPositions =
    chapters.length > 0 && chapters.every((chapter) => Number.isInteger(chapter.position));
  const compareChapters = hasPositions
    ? (first, second) =>
        first.position - second.position || compareByCreatedAt(first, second)
    : compareByCreatedAt;
  return chapters.sort(compareChapters);
}

function associationEntryId(association) {
  const entryId = association && (association.entryId || association.entry_id);
  requireNonblankString(entryId, "Book association Entry ID");
  return entryId;
}

function chapterAssociationId(association) {
  if (typeof association === "string") {
    return association;
  }
  return association && (association.id || association.chapterId || association.chapter_id);
}

function collectBookEntryIds(bookAssociations) {
  const entryIds = new Set();
  const directEntryIds = new Set();
  for (const association of bookAssociations) {
    const entryId = associationEntryId(association);
    entryIds.add(entryId);
    if (association.source === "direct") {
      directEntryIds.add(entryId);
    }
  }
  return { entryIds, directEntryIds };
}

async function loadBookEntries(entryIds, bookId, entries) {
  const records = await Promise.all(
    [...entryIds].map(async (entryId) => {
      const entry = await entries.findById(entryId);
      if (!entry) {
        throw new Error(`Entry ${entryId} associated with Book ${bookId} was not found.`);
      }
      if (typeof entry.content !== "string") {
        throw new Error(`Entry ${entryId} has no exportable Content.`);
      }
      return [entryId, entry];
    }),
  );
  return new Map(records);
}

async function loadEntryChapterAssociations(entryIds, entryChapters) {
  const records = await Promise.all(
    [...entryIds].map(async (entryId) => {
      const associations = await entryChapters.listForEntry(entryId);
      if (!Array.isArray(associations)) {
        throw new TypeError("Entry-Chapters repository must return an array.");
      }
      return [entryId, associations];
    }),
  );
  return new Map(records);
}

function groupEntriesByChapter(chapters, entryById, chapterAssociations) {
  const chapterOrder = new Map(chapters.map((chapter, index) => [chapter.id, index]));
  const chapterEntries = new Map(chapters.map((chapter) => [chapter.id, []]));
  const placedEntryIds = new Set();

  for (const [entryId, associations] of chapterAssociations) {
    const chapterIds = associations
      .map(chapterAssociationId)
      .filter((chapterId) => chapterOrder.has(chapterId))
      .sort((first, second) => chapterOrder.get(first) - chapterOrder.get(second));
    const chapterId = chapterIds[0];
    if (chapterId && !placedEntryIds.has(entryId)) {
      chapterEntries.get(chapterId).push(entryById.get(entryId));
      placedEntryIds.add(entryId);
    }
  }
  return { chapterEntries, placedEntryIds };
}

function formatBookContents(book, chapters, chapterEntries, generalNotes) {
  const sections = [`# ${book.name}`];
  for (const chapter of chapters) {
    const contents = chapterEntries
      .get(chapter.id)
      .map((entry) => entry.content)
      .join("\n\n");
    sections.push(`## ${chapter.name}${contents ? `\n\n${contents}` : ""}`);
  }
  if (generalNotes.length > 0) {
    sections.push(
      `## General Book Notes\n\n${generalNotes.map((entry) => entry.content).join("\n\n")}`,
    );
  }
  return sections.join("\n\n");
}

function createExportService({
  entries,
  books,
  chapters,
  entryBooks,
  entryChapters,
  fileStorage,
  auditLog,
  now,
} = {}) {
  requireMethod(entries, "findById", "Entries repository");
  requireMethod(books, "findById", "Books repository");
  requireMethod(chapters, "listByBookId", "Chapters repository");
  requireMethod(entryBooks, "listForBook", "Entry-Books repository");
  requireMethod(entryChapters, "listForEntry", "Entry-Chapters repository");
  requireMethod(fileStorage, "writeTextFile", "File storage");
  requireMethod(auditLog, "record", "Audit log");
  if (typeof now !== "function") {
    throw new TypeError("Export service requires a clock function.");
  }

  async function saveExport(resourceType, resourceId, contents) {
    const timestamp = now();
    if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
      throw new TypeError("Export clock must return a valid Date.");
    }

    const fileName = `${resourceType}-${safeFilePart(resourceId)}.txt`;
    const result = await fileStorage.writeTextFile({
      fileName,
      contents,
      encoding: "utf8",
    });
    if (!result || typeof result.uri !== "string" || !result.uri.endsWith(".txt")) {
      throw new Error("File storage did not return a completed .txt export.");
    }

    await auditLog.record({
      event: `${resourceType}.export`,
      resourceId,
      occurredAt: timestamp.toISOString(),
    });
    return result;
  }

  async function exportEntry(entryId) {
    requireNonblankString(entryId, "Entry ID");
    const entry = await entries.findById(entryId);
    if (!entry) {
      throw new Error(`Entry ${entryId} was not found.`);
    }
    if (typeof entry.content !== "string") {
      throw new Error(`Entry ${entryId} has no exportable Content.`);
    }
    return saveExport("entry", entryId, entry.content);
  }

  async function exportBook(bookId) {
    requireNonblankString(bookId, "Book ID");
    const book = await books.findById(bookId);
    if (!book) {
      throw new Error(`Book ${bookId} was not found.`);
    }

    const [chapterRecords, bookAssociations] = await Promise.all([
      chapters.listByBookId(bookId),
      entryBooks.listForBook(bookId),
    ]);
    if (!Array.isArray(chapterRecords) || !Array.isArray(bookAssociations)) {
      throw new TypeError("Book export repositories must return arrays.");
    }

    const orderedChapters = orderChapters(chapterRecords);
    const { entryIds, directEntryIds } = collectBookEntryIds(bookAssociations);
    const entryById = await loadBookEntries(entryIds, bookId, entries);
    const chapterAssociations = await loadEntryChapterAssociations(entryIds, entryChapters);
    const { chapterEntries, placedEntryIds } = groupEntriesByChapter(
      orderedChapters,
      entryById,
      chapterAssociations,
    );
    const generalNotes = [...directEntryIds]
      .filter((entryId) => !placedEntryIds.has(entryId))
      .map((entryId) => entryById.get(entryId));

    return saveExport(
      "book",
      bookId,
      formatBookContents(book, orderedChapters, chapterEntries, generalNotes),
    );
  }

  return {
    exportEntry,
    exportBook,
  };
}

module.exports = {
  createExportService,
};
