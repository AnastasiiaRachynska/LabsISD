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
  ["REQ-F-008", "AC-F-008"],
  ["REQ-F-017", "AC-F-017"],
  ["REQ-F-018", "AC-F-018"],
  ["REQ-F-019", "AC-F-019"],
  ["REQ-F-020", "AC-F-020"],
  ["REQ-F-021", "AC-F-021"],
  ["REQ-NF-005", "AC-NF-005"],
  ["REQ-NF-006", "AC-NF-006"],
  ["REQ-NF-012", "AC-NF-012"],
];

function createEntriesRepository() {
  const records = new Map([
    ["entry-a", { id: "entry-a", content: "First note", entryType: "General Note" }],
    ["entry-b", { id: "entry-b", content: "Second note", entryType: "Scene" }],
  ]);
  return {
    findById: jest.fn(async (id) => records.get(id) || null),
    list: jest.fn(async () => [...records.values()].map((record) => ({ ...record }))),
    delete: jest.fn(async (id) => records.delete(id)),
  };
}

function createEntryLinksRepository() {
  const links = new Set();
  function orderPair(firstId, secondId) {
    return firstId < secondId ? [firstId, secondId] : [secondId, firstId];
  }
  function key(firstId, secondId) {
    return JSON.stringify(orderPair(firstId, secondId));
  }

  return {
    add: jest.fn(async (firstId, secondId) => {
      links.add(key(firstId, secondId));
    }),
    remove: jest.fn(async (firstId, secondId) => {
      links.delete(key(firstId, secondId));
    }),
    listForEntry: jest.fn(async (entryId) =>
      [...links]
        .map((link) => JSON.parse(link))
        .filter(([firstId, secondId]) => firstId === entryId || secondId === entryId)
        .map(([firstId, secondId]) => ({
          entryId: firstId === entryId ? secondId : firstId,
        })),
    ),
  };
}

function createHarness() {
  const entries = createEntriesRepository();
  const entryLinks = createEntryLinksRepository();
  const auditLog = { record: jest.fn(async () => undefined) };
  const { createEntryRelationshipService } = require("../src/wnt08/entry-relationships");
  const service = createEntryRelationshipService({
    entries,
    entryLinks,
    auditLog,
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  });
  return { service, entries, entryLinks, auditLog };
}

describe("WNT-08 SRS and acceptance-criteria traceability", () => {
  test.each(requirementMap)("%s maps to %s and WNT-08", (requirementId, criterionId) => {
    expect(srs).toContain(requirementId);
    expect(srs).toContain(criterionId);

    const row = traceabilityMatrix
      .split(/\r?\n/)
      .find((line) => line.includes(`${requirementId} & ${criterionId}`));
    expect(row).toContain("WNT-08");
  });
});

describe("WNT-08 Entry links and safe deletion", () => {
  test("requires valid service dependencies", () => {
    const { createEntryRelationshipService } = require("../src/wnt08/entry-relationships");
    const validDependencies = {
      entries: { findById: jest.fn(), delete: jest.fn() },
      entryLinks: { add: jest.fn(), remove: jest.fn(), listForEntry: jest.fn() },
      auditLog: { record: jest.fn() },
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    };

    expect(() => createEntryRelationshipService()).toThrow(
      "Entry relationship dependencies are required.",
    );
    expect(() => createEntryRelationshipService([])).toThrow(
      "Entry relationship dependencies are required.",
    );
    expect(() =>
      createEntryRelationshipService({ ...validDependencies, entries: null }),
    ).toThrow("Entries dependency does not implement the required methods.");
    expect(() =>
      createEntryRelationshipService({
        ...validDependencies,
        entryLinks: { ...validDependencies.entryLinks, add: undefined },
      }),
    ).toThrow("Entry Links dependency does not implement the required methods.");
    expect(() =>
      createEntryRelationshipService({ ...validDependencies, auditLog: null }),
    ).toThrow("Audit Log dependency does not implement the required methods.");
    expect(() =>
      createEntryRelationshipService({ ...validDependencies, now: undefined }),
    ).toThrow("Entry relationships require a clock function.");
  });

  test("[REQ-F-019, REQ-F-020] adds an unlabeled symmetric Entry Link without changing either Entry", async () => {
    const { service, entries, entryLinks, auditLog } = createHarness();
    const firstEntryBefore = await entries.findById("entry-a");
    const secondEntryBefore = await entries.findById("entry-b");

    await service.addEntryLink("entry-a", "entry-b");

    expect(entryLinks.add).toHaveBeenCalledWith("entry-a", "entry-b");
    expect(entryLinks.add.mock.calls[0]).toHaveLength(2);
    await expect(service.listLinkedEntries("entry-a")).resolves.toEqual([
      expect.objectContaining({ id: "entry-b" }),
    ]);
    await expect(service.listLinkedEntries("entry-b")).resolves.toEqual([
      expect.objectContaining({ id: "entry-a" }),
    ]);
    await expect(entries.findById("entry-a")).resolves.toEqual(firstEntryBefore);
    await expect(entries.findById("entry-b")).resolves.toEqual(secondEntryBefore);
    expect(auditLog.record).toHaveBeenCalledWith({
      event: "entry.link.add",
      resourceId: "entry-a",
      occurredAt: "2026-01-02T03:04:05.000Z",
    });
  });

  test("[REQ-F-019] rejects self-links and links to missing Entries", async () => {
    const { service, entryLinks, auditLog } = createHarness();

    await expect(service.addEntryLink("entry-a", "entry-a")).rejects.toThrow();
    await expect(service.addEntryLink("entry-a", "missing-entry")).rejects.toThrow();

    expect(entryLinks.add).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  test("rejects blank Entry IDs and invalid audit clock values", async () => {
    const { service, entryLinks, auditLog } = createHarness();
    await expect(service.addEntryLink(" ", "entry-b")).rejects.toThrow(
      "Entry ID must be a nonblank string.",
    );
    await expect(service.addEntryLink("entry-a", "")).rejects.toThrow(
      "Linked Entry ID must be a nonblank string.",
    );
    await expect(service.listLinkedEntries("")).rejects.toThrow(
      "Entry ID must be a nonblank string.",
    );
    expect(entryLinks.add).not.toHaveBeenCalled();

    const { createEntryRelationshipService } = require("../src/wnt08/entry-relationships");
    for (const invalidDate of ["not-a-date", new Date(Number.NaN)]) {
      const { entries, entryLinks: links, auditLog: log } = createHarness();
      const invalidClockService = createEntryRelationshipService({
        entries,
        entryLinks: links,
        auditLog: log,
        now: () => invalidDate,
      });

      await expect(invalidClockService.addEntryLink("entry-a", "entry-b")).rejects.toThrow(
        "Clock must return a valid Date.",
      );
      expect(log.record).not.toHaveBeenCalled();
    }
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  test("[REQ-F-021] removes a link from either Entry and keeps both Entries available", async () => {
    const { service, entries, entryLinks, auditLog } = createHarness();
    await service.addEntryLink("entry-a", "entry-b");

    await service.removeEntryLink("entry-b", "entry-a");

    expect(entryLinks.remove).toHaveBeenCalledWith("entry-b", "entry-a");
    await expect(service.listLinkedEntries("entry-a")).resolves.toEqual([]);
    await expect(service.listLinkedEntries("entry-b")).resolves.toEqual([]);
    await expect(entries.findById("entry-a")).resolves.toMatchObject({ content: "First note" });
    await expect(entries.findById("entry-b")).resolves.toMatchObject({ content: "Second note" });
    expect(auditLog.record).toHaveBeenLastCalledWith({
      event: "entry.link.remove",
      resourceId: "entry-b",
      occurredAt: "2026-01-02T03:04:05.000Z",
    });
  });

  test("[REQ-F-008, REQ-F-020] deleting a linked Entry removes its links but preserves the other Entry", async () => {
    const { service, entries, entryLinks, auditLog } = createHarness();
    await service.addEntryLink("entry-a", "entry-b");

    await service.deleteEntry("entry-a");

    await expect(entries.findById("entry-a")).resolves.toBeNull();
    await expect(entries.list()).resolves.toEqual([
      expect.objectContaining({ id: "entry-b", content: "Second note" }),
    ]);
    expect(entryLinks.remove).toHaveBeenCalledWith("entry-a", "entry-b");
    await expect(service.listLinkedEntries("entry-b")).resolves.toEqual([]);
    await expect(entries.findById("entry-b")).resolves.toMatchObject({
      id: "entry-b",
      content: "Second note",
    });
    expect(auditLog.record).toHaveBeenLastCalledWith({
      event: "entry.delete",
      resourceId: "entry-a",
      occurredAt: "2026-01-02T03:04:05.000Z",
    });
  });

  test("[REQ-F-008, REQ-NF-005] rejects deleting a missing Entry without changing relationships", async () => {
    const { service, entries, entryLinks, auditLog } = createHarness();
    await service.addEntryLink("entry-a", "entry-b");
    entryLinks.remove.mockClear();
    auditLog.record.mockClear();

    await expect(service.deleteEntry("missing-entry")).rejects.toThrow();

    expect(entries.delete).not.toHaveBeenCalled();
    expect(entryLinks.remove).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
    await expect(service.listLinkedEntries("entry-a")).resolves.toEqual([
      expect.objectContaining({ id: "entry-b" }),
    ]);
  });

  test("reports an Entry deletion failure and does not record a success event", async () => {
    const { service, entries, entryLinks, auditLog } = createHarness();
    entries.delete.mockResolvedValue(false);

    await expect(service.deleteEntry("entry-a")).rejects.toThrow(
      "Entry entry-a could not be deleted.",
    );

    expect(entryLinks.remove).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  test("omits stale references when resolving linked Entries", async () => {
    const { service, entries, entryLinks } = createHarness();
    entryLinks.listForEntry.mockResolvedValue([
      { entryId: "entry-b" },
      { entryId: "deleted-entry" },
    ]);

    await expect(service.listLinkedEntries("entry-a")).resolves.toEqual([
      expect.objectContaining({ id: "entry-b" }),
    ]);
    expect(entries.findById).toHaveBeenCalledWith("deleted-entry");
  });
});
