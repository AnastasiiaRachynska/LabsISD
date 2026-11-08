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
  ["REQ-F-001", "AC-F-001"],
  ["REQ-F-002", "AC-F-002"],
  ["REQ-F-003", "AC-F-003"],
  ["REQ-F-004", "AC-F-004"],
  ["REQ-F-005", "AC-F-005"],
  ["REQ-F-006", "AC-F-006"],
  ["REQ-F-007", "AC-F-007"],
  ["REQ-F-010", "AC-F-010"],
  ["REQ-NF-001", "AC-NF-001"],
  ["REQ-NF-003", "AC-NF-003"],
  ["REQ-NF-004", "AC-NF-004"],
  ["REQ-NF-007", "AC-NF-007"],
  ["REQ-NF-008", "AC-NF-008"],
  ["REQ-NF-009", "AC-NF-009"],
  ["REQ-NF-012", "AC-NF-012"],
  ["REQ-NF-013", "AC-NF-013"],
];

function loadSystemUnderTest() {
  return require("../src/wnt06/entry-capture");
}

function createLocalRepository() {
  const records = new Map();
  return {
    create: jest.fn(async (entry) => {
      records.set(entry.id, { ...entry });
      return { ...entry };
    }),
    findById: jest.fn(async (id) => {
      const entry = records.get(id);
      return entry ? { ...entry } : null;
    }),
    update: jest.fn(async (id, changes) => {
      const entry = records.get(id);
      if (!entry) return null;
      const updated = { ...entry, ...changes };
      records.set(id, updated);
      return { ...updated };
    }),
    list: jest.fn(async () => [...records.values()].map((entry) => ({ ...entry }))),
  };
}

function createHarness(overrides = {}) {
  const entries = overrides.entries || createLocalRepository();
  const pendingChanges = overrides.pendingChanges || {
    enqueue: jest.fn(async () => undefined),
  };
  const auditLog = overrides.auditLog || {
    record: jest.fn(async () => undefined),
  };
  let nextId = 0;
  const { createEntryCaptureService } = loadSystemUnderTest();

  return {
    entries,
    pendingChanges,
    auditLog,
    service: createEntryCaptureService({
      entries,
      pendingChanges,
      auditLog,
      createId: () => `entry-${++nextId}`,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    }),
  };
}

describe("WNT-06 SRS and acceptance-criteria traceability", () => {
  test.each(requirementMap)("%s maps to %s and WNT-06", (requirementId, criterionId) => {
    expect(srs).toContain(requirementId);
    expect(srs).toContain(criterionId);

    const row = traceabilityMatrix
      .split(/\r?\n/)
      .find((line) => line.includes(`${requirementId} & ${criterionId}`));
    expect(row).toContain("WNT-06");
  });
});

describe("WNT-06 offline Entry capture", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("[REQ-F-001, REQ-F-002, REQ-F-005, REQ-F-010] creates a content-only General Note that remains standalone", async () => {
    const { service, entries, pendingChanges } = createHarness();

    const entry = await service.createEntry({ content: "A captured idea" });

    expect(entry).toMatchObject({
      id: "entry-1",
      content: "A captured idea",
      title: null,
      displayTitle: "A captured idea",
      entryType: "General Note",
      tags: [],
      bookAssociations: [],
      chapterAssociations: [],
      entryLinks: [],
    });
    await expect(service.getEntry(entry.id)).resolves.toMatchObject(entry);
    await expect(service.listEntries()).resolves.toContainEqual(entry);
    expect(entries.create).toHaveBeenCalledTimes(1);
    expect(pendingChanges.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "create",
        resourceType: "entry",
        resourceId: entry.id,
      }),
    );
  });

  test.each(["", " \t\n "])("[REQ-F-002] rejects blank Content %j without saving or queueing", async (content) => {
    const { service, entries, pendingChanges } = createHarness();

    await expect(service.createEntry({ content })).rejects.toThrow();

    expect(entries.create).not.toHaveBeenCalled();
    expect(pendingChanges.enqueue).not.toHaveBeenCalled();
  });

  test.each([
    ["under the limit", "A short note", "A short note"],
    ["at the limit", "1234567890123456789012345", "1234567890123456789012345"],
    ["over the limit", "12345678901234567890123456", "1234567890123456789012345..."],
    ["newline before the limit", "First line\nsecond line", "First line..."],
    ["newline at the limit", "123456789012345678901234\nnext", "123456789012345678901234..."],
  ])("[REQ-F-003] derives Display Title correctly when Content is %s", async (_boundary, content, displayTitle) => {
    const { service } = createHarness();

    await expect(service.createEntry({ content, title: " \t " })).resolves.toMatchObject({
      content,
      displayTitle,
    });
  });

  test("[REQ-F-003] preserves an explicit nonblank Title", async () => {
    const { service } = createHarness();

    await expect(
      service.createEntry({
        content: "Content longer than twenty-five characters",
        title: "Explicit title",
      }),
    ).resolves.toMatchObject({
      title: "Explicit title",
      displayTitle: "Explicit title",
    });
  });

  test("[REQ-F-004] provides exactly the six specified Entry Types", () => {
    const { ENTRY_TYPES } = loadSystemUnderTest();

    expect(ENTRY_TYPES).toEqual([
      "Character",
      "Scene",
      "Plot Idea",
      "World-building",
      "Dialogue/Phrase",
      "General Note",
    ]);
  });

  test("[REQ-F-004] rejects an Entry Type outside the preset list", async () => {
    const { service, entries } = createHarness();

    await expect(
      service.createEntry({ content: "Valid content", entryType: "Unsupported" }),
    ).rejects.toThrow();
    expect(entries.create).not.toHaveBeenCalled();
  });

  test("[REQ-F-006, REQ-F-007] returns Entry details and persists supported edits", async () => {
    const { service } = createHarness();
    const entry = await service.createEntry({
      content: "Original content",
      title: "Original title",
      entryType: "Scene",
    });

    await service.updateEntry(entry.id, {
      content: "Edited content",
      title: "Edited title",
      entryType: "Character",
      tags: ["tag-1"],
      bookAssociations: ["book-1"],
      chapterAssociations: ["chapter-1"],
      entryLinks: ["entry-2"],
    });

    await expect(service.getEntry(entry.id)).resolves.toMatchObject({
      content: "Edited content",
      title: "Edited title",
      displayTitle: "Edited title",
      entryType: "Character",
      tags: ["tag-1"],
      bookAssociations: ["book-1"],
      chapterAssociations: ["chapter-1"],
      entryLinks: ["entry-2"],
    });
  });

  test("[REQ-F-003, REQ-F-007] updates a Title without replacing existing Content", async () => {
    const { service } = createHarness();
    const entry = await service.createEntry({ content: "Existing content" });

    await expect(
      service.updateEntry(entry.id, { title: "New explicit title" }),
    ).resolves.toMatchObject({
      content: "Existing content",
      title: "New explicit title",
      displayTitle: "New explicit title",
    });
  });

  test("[REQ-F-007, REQ-NF-003] queues offline edits and makes no network request", async () => {
    const fetch = jest.spyOn(global, "fetch").mockRejectedValue(
      new Error("Network unavailable"),
    );
    const { service, pendingChanges } = createHarness();
    const entry = await service.createEntry({ content: "Before edit" });
    pendingChanges.enqueue.mockClear();

    await service.updateEntry(entry.id, { content: "After edit" });

    expect(fetch).not.toHaveBeenCalled();
    expect(pendingChanges.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "update",
        resourceType: "entry",
        resourceId: entry.id,
      }),
    );
    await expect(service.getEntry(entry.id)).resolves.toMatchObject({
      content: "After edit",
    });
  });

  test("[REQ-F-007] rejects invalid edits before writing or queueing", async () => {
    const { service, entries, pendingChanges } = createHarness();
    const entry = await service.createEntry({ content: "Valid idea" });
    entries.update.mockClear();
    pendingChanges.enqueue.mockClear();

    await expect(service.updateEntry(entry.id, null)).rejects.toThrow();
    await expect(service.updateEntry(entry.id, {})).rejects.toThrow();
    await expect(service.updateEntry(entry.id, { unknownField: true })).rejects.toThrow();
    await expect(service.updateEntry(entry.id, { content: " \t " })).rejects.toThrow();

    expect(entries.update).not.toHaveBeenCalled();
    expect(pendingChanges.enqueue).not.toHaveBeenCalled();
  });

  test("[REQ-NF-012] records create and update audit events with ISO-8601 UTC timestamps", async () => {
    const { service, auditLog } = createHarness();
    const entry = await service.createEntry({ content: "Audited idea" });
    await service.updateEntry(entry.id, { content: "Updated idea" });

    expect(auditLog.record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event: "entry.create",
        resourceId: entry.id,
        occurredAt: "2026-01-02T03:04:05.000Z",
      }),
    );
    expect(auditLog.record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event: "entry.update",
        resourceId: entry.id,
        occurredAt: "2026-01-02T03:04:05.000Z",
      }),
    );
  });
});

describe("WNT-06 acceptance requiring the mobile app or platform harness", () => {
  test.todo("[REQ-NF-001] saves within 1 second on a supported simulator with 1,000 SQLite Entries");
  test.todo("[REQ-NF-003, REQ-NF-004] verifies the offline workflows and durable expo-sqlite data/queue after app restart");
  test.todo("[REQ-NF-007] installs and launches on Android API 29+ and iOS 15+");
  test.todo("[REQ-NF-008] verifies no clipped controls or horizontal scrolling at 360 x 640 dp");
  test.todo("[REQ-NF-009] verifies accessibilityLabel values and platform text scaling");
  test.todo("[REQ-NF-012] verifies the 2 MB FIFO audit-log rotation limit");
  test.todo("[REQ-NF-013] verifies the app exposes no diagnostic-log UI");
});
