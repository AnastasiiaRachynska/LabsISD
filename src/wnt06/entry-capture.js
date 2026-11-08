"use strict";

const ENTRY_TYPES = [
  "Character",
  "Scene",
  "Plot Idea",
  "World-building",
  "Dialogue/Phrase",
  "General Note",
];

const EDITABLE_FIELDS = new Set([
  "content",
  "title",
  "entryType",
  "tags",
  "bookAssociations",
  "chapterAssociations",
  "entryLinks",
]);

const ASSOCIATION_FIELDS = [
  "tags",
  "bookAssociations",
  "chapterAssociations",
  "entryLinks",
];

function isNonblankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function deriveDisplayTitle(content) {
  const first25Characters = content.slice(0, 25);
  const newlineIndex = first25Characters.indexOf("\n");

  if (newlineIndex !== -1) {
    return `${first25Characters.slice(0, newlineIndex)}...`;
  }

  if (content.length > 25) {
    return `${first25Characters}...`;
  }

  return first25Characters;
}

function resolveTitle(content, title) {
  const explicitTitle = isNonblankString(title) ? title : null;
  return {
    title: explicitTitle,
    displayTitle: explicitTitle || deriveDisplayTitle(content),
  };
}

function defaultToEmptyArray(value) {
  return value === undefined ? [] : value;
}

function validateContent(content) {
  if (!isNonblankString(content)) {
    throw new TypeError("Entry Content must be a nonblank string.");
  }
}

function validateEntryType(entryType) {
  if (!ENTRY_TYPES.includes(entryType)) {
    throw new TypeError("Entry Type must be one of the preset Entry Types.");
  }
}

function validateAssociations(values) {
  for (const field of ASSOCIATION_FIELDS) {
    if (hasOwn(values, field) && !Array.isArray(values[field])) {
      throw new TypeError(`${field} must be an array.`);
    }
  }
}

function createEntryCaptureService({ entries, pendingChanges, auditLog, createId, now }) {
  if (
    !entries ||
    !pendingChanges ||
    !auditLog ||
    typeof createId !== "function" ||
    typeof now !== "function"
  ) {
    throw new TypeError("Entry capture requires repositories, logging, ID, and clock dependencies.");
  }
  if (
    typeof entries.create !== "function" ||
    typeof entries.findById !== "function" ||
    typeof entries.update !== "function" ||
    typeof entries.list !== "function" ||
    typeof pendingChanges.enqueue !== "function" ||
    typeof auditLog.record !== "function"
  ) {
    throw new TypeError("Entry capture dependencies do not implement the required methods.");
  }

  async function createEntry(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("Entry details must be provided as an object.");
    }
    validateContent(input.content);

    const entryType = input.entryType === undefined ? "General Note" : input.entryType;
    validateEntryType(entryType);

    const entry = {
      id: createId(),
      content: input.content,
      ...resolveTitle(input.content, input.title),
      entryType,
      tags: defaultToEmptyArray(input.tags),
      bookAssociations: defaultToEmptyArray(input.bookAssociations),
      chapterAssociations: defaultToEmptyArray(input.chapterAssociations),
      entryLinks: defaultToEmptyArray(input.entryLinks),
    };
    validateAssociations(entry);

    const savedEntry = await entries.create(entry);
    await recordChange("create", entry.id);
    return savedEntry;
  }

  async function updateEntry(id, changes) {
    if (!isNonblankString(id)) {
      throw new TypeError("Entry ID must be a nonblank string.");
    }
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      throw new TypeError("Entry changes must be provided as an object.");
    }
    const fields = Object.keys(changes);
    if (fields.length === 0 || fields.some((field) => !EDITABLE_FIELDS.has(field))) {
      throw new TypeError("Entry changes must contain supported editable fields.");
    }

    if (hasOwn(changes, "content")) {
      validateContent(changes.content);
    }
    if (
      hasOwn(changes, "title") &&
      changes.title !== null &&
      changes.title !== undefined &&
      typeof changes.title !== "string"
    ) {
      throw new TypeError("Entry Title must be a string or null.");
    }
    if (hasOwn(changes, "entryType")) {
      validateEntryType(changes.entryType);
    }
    validateAssociations(changes);

    const existing = await entries.findById(id);
    if (!existing) {
      throw new Error(`Entry ${id} was not found.`);
    }

    const updatedFields = { ...changes };
    const updatedContent = updatedFields.content ?? existing.content;
    const updatedTitle = hasOwn(updatedFields, "title")
      ? updatedFields.title
      : existing.title;
    Object.assign(updatedFields, resolveTitle(updatedContent, updatedTitle));

    const updatedEntry = await entries.update(id, updatedFields);
    if (!updatedEntry) {
      throw new Error(`Entry ${id} could not be updated.`);
    }
    await recordChange("update", id);
    return updatedEntry;
  }

  async function recordChange(operation, resourceId) {
    await pendingChanges.enqueue({
      operation,
      resourceType: "entry",
      resourceId,
    });
    await auditLog.record({
      event: `entry.${operation}`,
      resourceId,
      occurredAt: now().toISOString(),
    });
  }

  return {
    createEntry,
    updateEntry,
    getEntry(id) {
      return entries.findById(id);
    },
    listEntries() {
      return entries.list();
    },
  };
}

module.exports = {
  ENTRY_TYPES,
  createEntryCaptureService,
};
