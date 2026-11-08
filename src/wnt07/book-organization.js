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

  async function createBook(input) {
    validateNameInput(input, "Book");
    const book = await books.create({ id: createId(), name: input.name });
    await recordEvent("book.create", book.id);
    return book;
  }

  async function updateBook(bookId, changes) {
    await requireBook(bookId);
    validateNameInput(changes, "Book");
    const book = await books.update(bookId, changes);
    requireRecord(book, "Book", bookId);
    await recordEvent("book.update", bookId);
    return book;
  }

  async function deleteBook(bookId) {
    await requireBook(bookId);
    const bookChapters = await chapters.listByBookId(bookId);
    for (const chapter of bookChapters) {
      await entryChapters.detachChapter(chapter.id);
      await chapters.delete(chapter.id);
      await recordEvent("chapter.delete", chapter.id);
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
    validateNameInput(input, "Chapter");
    const chapter = await chapters.create({
      id: createId(),
      bookId,
      name: input.name,
    });
    await recordEvent("chapter.create", chapter.id);
    return chapter;
  }

  async function updateChapter(chapterId, changes) {
    await requireChapter(chapterId);
    validateNameInput(changes, "Chapter");
    const chapter = await chapters.update(chapterId, changes);
    requireRecord(chapter, "Chapter", chapterId);
    await recordEvent("chapter.update", chapterId);
    return chapter;
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

    const [remainingChapters, bookAssociations] = await Promise.all([
      entryChapters.listForEntry(entryId),
      entryBooks.listForEntry(entryId),
    ]);
    const hasOtherChapterInBook = await Promise.all(
      remainingChapters
        .filter((association) => (association.chapterId || association.id) !== chapterId)
        .map(async (association) => {
          const otherChapterId = association.chapterId || association.id;
          const otherChapter = await chapters.findById(otherChapterId);
          return otherChapter && otherChapter.bookId === chapter.bookId;
        }),
    ).then((results) => results.some(Boolean));
    const hasDirectBookAssociation = bookAssociations.some(
      (association) => association.bookId === chapter.bookId && association.source === "direct",
    );

    if (!hasOtherChapterInBook || hasDirectBookAssociation) {
      await entryBooks.remove(entryId, chapter.bookId, "chapter-derived");
    }
    await recordEvent("entry.chapter-association.remove", entryId);
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
