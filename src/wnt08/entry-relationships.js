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

function validateDependencies({ entries, entryLinks, auditLog, now }) {
  const requiredMethods = [
    [entries, ["findById", "delete"], "Entries"],
    [entryLinks, ["add", "remove", "listForEntry"], "Entry Links"],
    [auditLog, ["record"], "Audit Log"],
  ];

  if (typeof now !== "function") {
    throw new TypeError("Entry relationships require a clock function.");
  }
  for (const [dependency, methods, label] of requiredMethods) {
    if (!dependency || methods.some((method) => typeof dependency[method] !== "function")) {
      throw new TypeError(`${label} dependency does not implement the required methods.`);
    }
  }
}

function createEntryRelationshipService(dependencies) {
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw new TypeError("Entry relationship dependencies are required.");
  }
  const { entries, entryLinks, auditLog, now } = dependencies;
  validateDependencies(dependencies);

  async function requireEntry(entryId) {
    if (!isNonblankString(entryId)) {
      throw new TypeError("Entry ID must be a nonblank string.");
    }
    return requireRecord(await entries.findById(entryId), "Entry", entryId);
  }

  async function recordEvent(event, resourceId) {
    const timestamp = now();
    if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
      throw new TypeError("Clock must return a valid Date.");
    }
    await auditLog.record({
      event,
      resourceId,
      occurredAt: timestamp.toISOString(),
    });
  }

  async function addEntryLink(entryId, linkedEntryId) {
    if (!isNonblankString(linkedEntryId)) {
      throw new TypeError("Linked Entry ID must be a nonblank string.");
    }
    if (entryId === linkedEntryId) {
      throw new TypeError("An Entry cannot be linked to itself.");
    }
    await requireEntry(entryId);
    await requireEntry(linkedEntryId);
    await entryLinks.add(entryId, linkedEntryId);
    await recordEvent("entry.link.add", entryId);
  }

  async function removeEntryLink(entryId, linkedEntryId) {
    if (!isNonblankString(linkedEntryId)) {
      throw new TypeError("Linked Entry ID must be a nonblank string.");
    }
    if (entryId === linkedEntryId) {
      throw new TypeError("An Entry cannot be linked to itself.");
    }
    await requireEntry(entryId);
    await requireEntry(linkedEntryId);
    await entryLinks.remove(entryId, linkedEntryId);
    await recordEvent("entry.link.remove", entryId);
  }

  async function listLinkedEntries(entryId) {
    await requireEntry(entryId);
    const links = await entryLinks.listForEntry(entryId);
    const linkedEntries = await Promise.all(
      links.map((link) => entries.findById(link.entryId)),
    );
    return linkedEntries.filter(Boolean);
  }

  async function deleteEntry(entryId) {
    await requireEntry(entryId);
    const links = await entryLinks.listForEntry(entryId);
    for (const link of links) {
      await entryLinks.remove(entryId, link.entryId);
    }
    const deleted = await entries.delete(entryId);
    if (!deleted) {
      throw new Error(`Entry ${entryId} could not be deleted.`);
    }
    await recordEvent("entry.delete", entryId);
  }

  return {
    addEntryLink,
    removeEntryLink,
    listLinkedEntries,
    deleteEntry,
  };
}

module.exports = {
  createEntryRelationshipService,
};
