"use strict";

function isNonblankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateCriteria(criteria) {
  if (
    criteria !== undefined &&
    (!criteria || typeof criteria !== "object" || Array.isArray(criteria))
  ) {
    throw new TypeError("Search criteria must be an object.");
  }
  if (!criteria) {
    return { query: "", entryTypes: [], tagIds: [] };
  }
  const supportedFields = new Set(["query", "entryTypes", "tagIds"]);
  if (Object.keys(criteria).some((field) => !supportedFields.has(field))) {
    throw new TypeError("Search criteria contain unsupported fields.");
  }

  const { query = "", entryTypes = [], tagIds = [] } = criteria;
  if (typeof query !== "string") {
    throw new TypeError("Search query must be a string.");
  }
  if (!Array.isArray(entryTypes) || entryTypes.some((type) => !isNonblankString(type))) {
    throw new TypeError("Entry Type filters must be an array of nonblank strings.");
  }
  if (!Array.isArray(tagIds) || tagIds.some((tagId) => !isNonblankString(tagId))) {
    throw new TypeError("Tag filters must be an array of nonblank strings.");
  }

  return {
    query: query.trim().toLowerCase(),
    entryTypes,
    tagIds,
  };
}

function matchesQuery(entry, query) {
  if (!query) {
    return true;
  }
  return [entry.title, entry.displayTitle, entry.content].some(
    (value) => typeof value === "string" && value.toLowerCase().includes(query),
  );
}

function matchesEveryTag(entry, tagIds) {
  const entryTags = Array.isArray(entry.tags) ? entry.tags : [];
  return tagIds.every((tagId) => entryTags.includes(tagId));
}

function createEntrySearchService({ entries } = {}) {
  if (!entries || typeof entries.list !== "function") {
    throw new TypeError("Entry search requires a repository with a list method.");
  }

  async function searchEntries(criteria) {
    const filters = validateCriteria(criteria);
    const records = await entries.list();

    return records.filter(
      (entry) =>
        matchesQuery(entry, filters.query) &&
        filters.entryTypes.every((entryType) => entry.entryType === entryType) &&
        matchesEveryTag(entry, filters.tagIds),
    );
  }

  return { searchEntries };
}

module.exports = {
  createEntrySearchService,
};
