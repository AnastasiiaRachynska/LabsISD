"use strict";

function isNonblankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requireRecord(record, kind, id) {
  if (!record) {
    throw new Error(`${kind} ${id} was not found.`);
  }
  return record;
}

function validateNameInput(input, label) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${label} details must be an object.`);
  }
  const keys = Object.keys(input);
  if (
    keys.length !== 1 ||
    keys[0] !== "name" ||
    typeof input.name !== "string" ||
    !isNonblankString(input.name)
  ) {
    throw new TypeError(`${label} must contain a valid name.`);
  }
}

function validateDependencies({
  books,
  chapters,
  entries,
  tags,
  entryTags,
  entryBooks,
  entryChapters,
  auditLog,
  createId,
  now,
}) {
  const requiredMethods = [
    [books, ["create", "findById", "update", "delete", "list"], "Books"],
    [chapters, ["create", "findById", "update", "delete", "list", "listByBookId"], "Chapters"],
    [entries, ["findById"], "Entries"],
    [tags, ["findById"], "Tags"],
    [entryTags, ["add", "remove", "listForEntry"], "Entry Tags"],
    [entryBooks, ["add", "remove", "listForEntry", "listForBook", "detachBook"], "Entry Books"],
    [entryChapters, ["add", "remove", "listForEntry", "detachChapter"], "Entry Chapters"],
    [auditLog, ["record"], "Audit Log"],
  ];

  if (typeof createId !== "function" || typeof now !== "function") {
    throw new TypeError("Book organization requires ID and clock functions.");
  }
  for (const [dependency, methods, label] of requiredMethods) {
    if (!dependency || methods.some((method) => typeof dependency[method] !== "function")) {
      throw new TypeError(`${label} dependency does not implement the required methods.`);
    }
  }
}

function createBookOrganizationService(dependencies) {
  if (!dependencies || typeof dependencies !== "object") {
    throw new TypeError("Book organization dependencies are required.");
  }
  const {
    books,
    chapters,
    entries,
    tags,
    entryTags,
    entryBooks,
    entryChapters,
    auditLog,
    createId,
    now,
  } = dependencies;
  validateDependencies(dependencies);

  async function recordEvent(event, resourceId) {
    await auditLog.record({
      event,
      resourceId,
      occurredAt: now().toISOString(),
    });
  }

  async function requireEntry(entryId) {
    return requireRecord(await entries.findById(entryId), "Entry", entryId);
  }

  async function requireBook(bookId) {
    return requireRecord(await books.findById(bookId), "Book", bookId);
  }

  async function requireChapter(chapterId) {
    return requireRecord(await chapters.findById(chapterId), "Chapter", chapterId);
  }

  async function createNamedRecord(repository, kind, input, additionalFields = {}) {
    validateNameInput(input, kind);
    const record = await repository.create({
      id: createId(),
      ...input,
      ...additionalFields,
    });
    await recordEvent(`${kind.toLowerCase()}.create`, record.id);
    return record;
  }

  async function updateNamedRecord(repository, kind, id, changes) {
    await requireRecord(await repository.findById(id), kind, id);
    validateNameInput(changes, kind);
    const record = await repository.update(id, changes);
    requireRecord(record, kind, id);
    await recordEvent(`${kind.toLowerCase()}.update`, id);
    return record;
  }

  async function createBook(input) {
    return createNamedRecord(books, "Book", input);
  }

  async function updateBook(bookId, changes) {
    return updateNamedRecord(books, "Book", bookId, changes);
  }

  async function deleteBook(bookId) {
    await requireBook(bookId);
    const bookChapters = await chapters.listByBookId(bookId);
    for (const chapter of bookChapters) {
      await deleteChapter(chapter.id);
    }
    await entryBooks.detachBook(bookId);
    const deleted = await books.delete(bookId);
    if (!deleted) {
      throw new Error(`Book ${bookId} could not be deleted.`);
    }
    await recordEvent("book.delete", bookId);
  }

  async function createChapter(bookId, input) {
    await requireBook(bookId);
    return createNamedRecord(chapters, "Chapter", input, { bookId });
  }

  async function updateChapter(chapterId, changes) {
    return updateNamedRecord(chapters, "Chapter", chapterId, changes);
  }

  async function deleteChapter(chapterId) {
    await requireChapter(chapterId);
    await entryChapters.detachChapter(chapterId);
    const deleted = await chapters.delete(chapterId);
    if (!deleted) {
      throw new Error(`Chapter ${chapterId} could not be deleted.`);
    }
    await recordEvent("chapter.delete", chapterId);
  }

  async function addTagToEntry(entryId, tagId) {
    await requireEntry(entryId);
    requireRecord(await tags.findById(tagId), "Tag", tagId);
    await entryTags.add(entryId, tagId);
    await recordEvent("entry.tag.add", entryId);
  }

  async function removeTagFromEntry(entryId, tagId) {
    await requireEntry(entryId);
    requireRecord(await tags.findById(tagId), "Tag", tagId);
    await entryTags.remove(entryId, tagId);
    await recordEvent("entry.tag.remove", entryId);
  }

  async function addBookAssociation(entryId, bookId) {
    await requireEntry(entryId);
    await requireBook(bookId);
    await entryBooks.add(entryId, bookId, "direct");
    await recordEvent("entry.book-association.add", entryId);
  }

  async function removeBookAssociation(entryId, bookId) {
    await requireEntry(entryId);
    await requireBook(bookId);
    await entryBooks.remove(entryId, bookId, "direct");
    await recordEvent("entry.book-association.remove", entryId);
  }

  async function addChapterAssociation(entryId, chapterId) {
    await requireEntry(entryId);
    const chapter = await requireChapter(chapterId);
    await requireBook(chapter.bookId);
    await entryChapters.add(entryId, chapterId);
    await entryBooks.add(entryId, chapter.bookId, "chapter-derived");
    await recordEvent("entry.chapter-association.add", entryId);
  }

  async function removeChapterAssociation(entryId, chapterId) {
    await requireEntry(entryId);
    const chapter = await requireChapter(chapterId);
    await entryChapters.remove(entryId, chapterId);

    const hasOtherChapterInBook = await hasChapterAssociationForBook(
      entryId,
      chapter.bookId,
      chapterId,
    );
    if (!hasOtherChapterInBook) {
      await entryBooks.remove(entryId, chapter.bookId, "chapter-derived");
    }
    await recordEvent("entry.chapter-association.remove", entryId);
  }

  async function hasChapterAssociationForBook(entryId, bookId, excludedChapterId) {
    const associations = await entryChapters.listForEntry(entryId);
    for (const association of associations) {
      const associatedChapterId = association.chapterId || association.id;
      if (associatedChapterId === excludedChapterId) {
        continue;
      }
      const associatedChapter = await chapters.findById(associatedChapterId);
      if (associatedChapter && associatedChapter.bookId === bookId) {
        return true;
      }
    }
    return false;
  }

  async function listEntriesForBook(bookId) {
    await requireBook(bookId);
    const associations = await entryBooks.listForBook(bookId);
    const linkedEntries = await Promise.all(
      associations.map((association) => entries.findById(association.entryId)),
    );
    return linkedEntries.filter(Boolean);
  }

  return {
    addTagToEntry,
    removeTagFromEntry,
    listTagsForEntry(entryId) {
      return entryTags.listForEntry(entryId);
    },
    createBook,
    listBooks() {
      return books.list();
    },
    getBook(bookId) {
      return books.findById(bookId);
    },
    updateBook,
    deleteBook,
    createChapter,
    listChapters(bookId) {
      return chapters.listByBookId(bookId);
    },
    getChapter(chapterId) {
      return chapters.findById(chapterId);
    },
    updateChapter,
    deleteChapter,
    addBookAssociation,
    removeBookAssociation,
    addChapterAssociation,
    removeChapterAssociation,
    listChaptersForEntry(entryId) {
      return entryChapters.listForEntry(entryId);
    },
    listEntriesForBook,
  };
}

module.exports = {
  createBookOrganizationService,
};
