"use strict";

const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "..");
const srs = fs.readFileSync(path.join(repositoryRoot, "spec/srs.tex"), "utf8");
const traceabilityMatrix = fs.readFileSync(
  path.join(repositoryRoot, "spec/traceability-matrix.tex"),
  "utf8",
);

const requirementMap = [
  ["REQ-F-022", "AC-F-022"],
  ["REQ-F-023", "AC-F-023"],
  ["REQ-F-024", "AC-F-024"],
  ["REQ-F-025", "AC-F-025"],
  ["REQ-NF-002", "AC-NF-002"],
  ["REQ-NF-003", "AC-NF-003"],
];

const entries = [
  {
    id: "entry-title",
    title: "The Clockwork City",
    displayTitle: "The Clockwork City",
    content: "A story about a mechanical metropolis.",
    entryType: "Scene",
    tags: ["tag-city", "tag-setting"],
  },
  {
    id: "entry-content",
    title: null,
    displayTitle: "The Lost Heir...",
    content: "The lost heir returns to the city.",
    entryType: "Plot Idea",
    tags: ["tag-city", "tag-character"],
  },
  {
    id: "entry-filtered",
    title: "Quiet Garden",
    displayTitle: "Quiet Garden",
    content: "A peaceful garden scene.",
    entryType: "Scene",
    tags: ["tag-setting"],
  },
  {
    id: "entry-unmatched",
    title: "Unrelated Note",
    displayTitle: "Unrelated Note",
    content: "Nothing relevant here.",
    entryType: "General Note",
    tags: [],
  },
];

function createHarness() {
  const repository = {
    list: jest.fn(async () => entries.map((entry) => ({ ...entry, tags: [...entry.tags] }))),
  };
  const { createEntrySearchService } = require("../src/wnt09/entry-search");
  return {
    repository,
    service: createEntrySearchService({ entries: repository }),
  };
}

describe("WNT-09 SRS and acceptance-criteria traceability", () => {
  test.each(requirementMap)("%s maps to %s and WNT-09", (requirementId, criterionId) => {
    expect(srs).toContain(requirementId);
    expect(srs).toContain(criterionId);

    const row = traceabilityMatrix
      .split(/\r?\n/)
      .find((line) => line.includes(`${requirementId} & ${criterionId}`));
    expect(row).toContain("WNT-09");
  });
});

describe("WNT-09 Entry search and combined filters", () => {
  test("requires a repository with list and validates criteria", async () => {
    const { createEntrySearchService } = require("../src/wnt09/entry-search");

    expect(() => createEntrySearchService()).toThrow(
      "Entry search requires a repository with a list method.",
    );
    expect(() => createEntrySearchService({ entries: {} })).toThrow(
      "Entry search requires a repository with a list method.",
    );

    const { service } = createHarness();
    await expect(service.searchEntries(null)).rejects.toThrow(
      "Search criteria must be an object.",
    );
    await expect(service.searchEntries([])).rejects.toThrow(
      "Search criteria must be an object.",
    );
    await expect(service.searchEntries({ query: 12 })).rejects.toThrow(
      "Search query must be a string.",
    );
    await expect(service.searchEntries({ entryTypes: "Scene" })).rejects.toThrow(
      "Entry Type filters must be an array of nonblank strings.",
    );
    await expect(service.searchEntries({ entryTypes: [" "] })).rejects.toThrow(
      "Entry Type filters must be an array of nonblank strings.",
    );
    await expect(service.searchEntries({ tagIds: "tag-city" })).rejects.toThrow(
      "Tag filters must be an array of nonblank strings.",
    );
    await expect(service.searchEntries({ tagIds: [" "] })).rejects.toThrow(
      "Tag filters must be an array of nonblank strings.",
    );
    await expect(service.searchEntries({ type: "Scene" })).rejects.toThrow(
      "Search criteria contain unsupported fields.",
    );
  });

  test("[REQ-F-022] searches Title and Content case-insensitively", async () => {
    const { service, repository } = createHarness();

    await expect(service.searchEntries({ query: "CLOCKWORK" })).resolves.toEqual([
      expect.objectContaining({ id: "entry-title" }),
    ]);
    await expect(service.searchEntries({ query: "RETURNS TO THE CITY" })).resolves.toEqual([
      expect.objectContaining({ id: "entry-content" }),
    ]);
    expect(repository.list).toHaveBeenCalledTimes(2);
  });

  test("[REQ-F-022] searches the generated Display Title", async () => {
    const { service } = createHarness();

    await expect(service.searchEntries({ query: "lost heir" })).resolves.toEqual([
      expect.objectContaining({
        id: "entry-content",
        title: null,
        displayTitle: "The Lost Heir...",
      }),
    ]);
  });

  test("[REQ-F-022] returns no results when the query matches no Entry", async () => {
    const { service } = createHarness();

    await expect(service.searchEntries({ query: "nonexistent phrase" })).resolves.toEqual([]);
  });

  test("[REQ-F-023] filters by one Entry Type and excludes other Types", async () => {
    const { service } = createHarness();

    await expect(service.searchEntries({ entryTypes: ["Scene"] })).resolves.toEqual([
      expect.objectContaining({ id: "entry-title", entryType: "Scene" }),
      expect.objectContaining({ id: "entry-filtered", entryType: "Scene" }),
    ]);
  });

  test("[REQ-F-023] applies strict AND logic to multiple selected Entry Types", async () => {
    const { service } = createHarness();

    await expect(
      service.searchEntries({ entryTypes: ["Scene", "Plot Idea"] }),
    ).resolves.toEqual([]);
  });

  test("[REQ-F-024] filters by Tag and requires every selected Tag", async () => {
    const { service } = createHarness();

    await expect(service.searchEntries({ tagIds: ["tag-city"] })).resolves.toEqual([
      expect.objectContaining({ id: "entry-title" }),
      expect.objectContaining({ id: "entry-content" }),
    ]);
    await expect(
      service.searchEntries({ tagIds: ["tag-city", "tag-character"] }),
    ).resolves.toEqual([expect.objectContaining({ id: "entry-content" })]);
  });

  test("[REQ-F-025] combines query, Entry Types, and Tags with strict AND logic", async () => {
    const { service } = createHarness();

    await expect(
      service.searchEntries({
        query: "city",
        entryTypes: ["Plot Idea"],
        tagIds: ["tag-city", "tag-character"],
      }),
    ).resolves.toEqual([expect.objectContaining({ id: "entry-content" })]);

    await expect(
      service.searchEntries({
        query: "city",
        entryTypes: ["Scene"],
        tagIds: ["tag-city", "tag-character"],
      }),
    ).resolves.toEqual([]);
    await expect(
      service.searchEntries({
        query: "city",
        entryTypes: ["Plot Idea"],
        tagIds: ["tag-city", "tag-setting"],
      }),
    ).resolves.toEqual([]);
    await expect(
      service.searchEntries({
        query: "garden",
        entryTypes: ["Plot Idea"],
        tagIds: ["tag-city"],
      }),
    ).resolves.toEqual([]);
  });

  test("[REQ-F-022, REQ-F-025] treats omitted or empty criteria as unfiltered search", async () => {
    const { service } = createHarness();

    await expect(service.searchEntries()).resolves.toHaveLength(entries.length);
    await expect(
      service.searchEntries({ query: "  ", entryTypes: [], tagIds: [] }),
    ).resolves.toHaveLength(entries.length);
  });

  test.todo(
    "[REQ-NF-002] returns search and filter results within 2 seconds on the minimum supported device with 1,000 SQLite Entries",
  );
});
