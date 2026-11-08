"use strict";

const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "..");
const srs = fs.readFileSync(path.join(repositoryRoot, "spec/srs.tex"), "utf8");
const openApi = fs.readFileSync(path.join(repositoryRoot, "spec/openapi.yaml"), "utf8");
const traceabilityMatrix = fs.readFileSync(
  path.join(repositoryRoot, "spec/traceability-matrix.tex"),
  "utf8",
);
const requirementMap = [
  ["REQ-F-035", "AC-F-035", true],
  ["REQ-F-036", "AC-F-036", true],
  ["REQ-F-037", "AC-F-037", true],
  ["REQ-NF-003", "AC-NF-003", false],
  ["REQ-NF-004", "AC-NF-004", false],
];

function createHarness(overrides = {}) {
  const pendingChanges = {
    list: jest.fn(async () => overrides.queuedChanges || []),
    removeAcknowledged: jest.fn(async () => undefined),
    enqueue: jest.fn(async (change) => ({ id: 99, ...change })),
  };
  const syncMetadata = {
    get: jest.fn(async () => overrides.cursor ?? null),
    set: jest.fn(async () => undefined),
  };
  const syncApi = {
    pushChanges: jest.fn(async () => ({
      status: 200,
      body: {
        results: (overrides.queuedChanges || []).map((change) => ({
          changeId: String(change.id),
          status: "acknowledged",
          resourceId: change.resourceId,
        })),
      },
    })),
    pullChanges: jest.fn(async () => ({
      status: 200,
      body: { changes: [], nextCursor: "cursor-next" },
    })),
  };
  const localStore = {
    withTransactionAsync: jest.fn(async (work) => work()),
    applyRemoteChange: jest.fn(async () => undefined),
  };
  const conflicts = {
    save: jest.fn(async () => undefined),
    findByChangeId: jest.fn(async (changeId) => overrides.conflict || null),
    remove: jest.fn(async () => undefined),
  };
  const { createSynchronizationService } = require("../src/wnt12/synchronization");

  return {
    pendingChanges,
    syncMetadata,
    syncApi,
    localStore,
    conflicts,
    service: createSynchronizationService({
      pendingChanges,
      syncMetadata,
      syncApi,
      localStore,
      conflicts,
      createId: () => "sync-request-1",
    }),
  };
}

describe("WNT-12 SRS, acceptance criteria, and OpenAPI traceability", () => {
  test.each(requirementMap)(
    "%s maps to %s and WNT-12",
    (requirementId, criterionId, appearsInOpenApi) => {
      expect(srs).toContain(requirementId);
      expect(srs).toContain(criterionId);
      if (appearsInOpenApi) {
        expect(openApi).toContain(requirementId);
      }

      const row = traceabilityMatrix
        .split(/\r?\n/)
        .find((line) => line.includes(`${requirementId} & ${criterionId}`));
      expect(row).toContain("WNT-12");
    },
  );
});

describe("WNT-12 offline synchronization", () => {
  test("[REQ-F-035] pushes queued create, update, and delete changes using the OpenAPI shapes", async () => {
    const queuedChanges = [
      {
        id: 1,
        operation: "create",
        resourceType: "entry",
        resourceId: "entry-new",
        payload: { id: "entry-new", content: "Created offline" },
      },
      {
        id: 2,
        operation: "update",
        resourceType: "entry",
        resourceId: "entry-existing",
        baseVersion: 4,
        payload: { id: "entry-existing", content: "Updated offline" },
      },
      {
        id: 3,
        operation: "delete",
        resourceType: "tag",
        resourceId: "tag-deleted",
        baseVersion: 2,
        payload: {},
      },
    ];
    const { service, syncApi, pendingChanges } = createHarness({ queuedChanges });

    const result = await service.pushPendingChanges();

    expect(syncApi.pushChanges).toHaveBeenCalledWith(
      {
        changes: [
          {
            changeId: "1",
            resourceType: "entry",
            operation: "create",
            resource: queuedChanges[0].payload,
          },
          {
            changeId: "2",
            resourceType: "entry",
            operation: "update",
            resourceId: "entry-existing",
            baseVersion: 4,
            resource: queuedChanges[1].payload,
          },
          {
            changeId: "3",
            resourceType: "tag",
            operation: "delete",
            resourceId: "tag-deleted",
            baseVersion: 2,
          },
        ],
      },
      { idempotencyKey: "sync-request-1" },
    );
    expect(pendingChanges.removeAcknowledged).toHaveBeenCalledWith([1, 2, 3]);
    expect(result).toMatchObject({ acknowledged: 3, remaining: 0 });
  });

  test("[REQ-F-035] does not send a request when there are no queued changes", async () => {
    const { service, syncApi } = createHarness();

    await expect(service.pushPendingChanges()).resolves.toMatchObject({
      acknowledged: 0,
      remaining: 0,
    });

    expect(syncApi.pushChanges).not.toHaveBeenCalled();
  });

  test("[REQ-F-035] retains unacknowledged changes and removes only acknowledged queue records", async () => {
    const queuedChanges = [
      { id: 10, operation: "create", resourceType: "entry", resourceId: "e10", payload: {} },
      { id: 11, operation: "create", resourceType: "entry", resourceId: "e11", payload: {} },
      { id: 12, operation: "create", resourceType: "entry", resourceId: "e12", payload: {} },
    ];
    const { service, syncApi, pendingChanges } = createHarness({ queuedChanges });
    syncApi.pushChanges.mockResolvedValue({
      status: 200,
      body: {
        results: [
          { changeId: "10", status: "acknowledged", resourceId: "e10" },
          { changeId: "12", status: "acknowledged", resourceId: "e12" },
        ],
      },
    });

    const result = await service.pushPendingChanges();

    expect(pendingChanges.removeAcknowledged).toHaveBeenCalledWith([10, 12]);
    expect(result).toMatchObject({ acknowledged: 2, remaining: 1 });
  });

  test("[REQ-F-035] retains all queued changes when the network request fails", async () => {
    const networkError = new Error("Offline");
    const { service, syncApi, pendingChanges } = createHarness({
      queuedChanges: [
        { id: 1, operation: "create", resourceType: "entry", resourceId: "e1", payload: {} },
      ],
    });
    syncApi.pushChanges.mockRejectedValue(networkError);

    await expect(service.pushPendingChanges()).rejects.toBe(networkError);

    expect(pendingChanges.removeAcknowledged).not.toHaveBeenCalled();
  });

  test("[REQ-F-035] rejects malformed acknowledgements without deleting queued work", async () => {
    const { service, syncApi, pendingChanges } = createHarness({
      queuedChanges: [
        { id: 1, operation: "create", resourceType: "entry", resourceId: "e1", payload: {} },
      ],
    });
    syncApi.pushChanges.mockResolvedValue({ status: 200, body: { results: null } });

    await expect(service.pushPendingChanges()).rejects.toThrow();

    expect(pendingChanges.removeAcknowledged).not.toHaveBeenCalled();
  });

  test("[REQ-F-036] applies pulled changes and persists the next cursor in the same transaction", async () => {
    const pulledChanges = [
      {
        resourceType: "entry",
        resourceId: "remote-entry",
        operation: "create",
        version: 1,
        resource: { id: "remote-entry", content: "Remote note" },
      },
      {
        resourceType: "entry",
        resourceId: "deleted-entry",
        operation: "delete",
        version: 3,
      },
    ];
    const { service, syncApi, syncMetadata, localStore } = createHarness({
      cursor: "cursor-saved",
    });
    syncApi.pullChanges.mockResolvedValue({
      status: 200,
      body: { changes: pulledChanges, nextCursor: "cursor-next" },
    });

    const result = await service.pullChanges();

    expect(syncApi.pullChanges).toHaveBeenCalledWith("cursor-saved");
    expect(localStore.withTransactionAsync).toHaveBeenCalledTimes(1);
    expect(localStore.applyRemoteChange).toHaveBeenNthCalledWith(1, pulledChanges[0]);
    expect(localStore.applyRemoteChange).toHaveBeenNthCalledWith(2, pulledChanges[1]);
    expect(syncMetadata.set).toHaveBeenCalledWith("syncCursor", "cursor-next");
    expect(result).toMatchObject({ applied: 2, cursor: "cursor-next" });
  });

  test("[REQ-F-036] does not advance the cursor if applying remote changes fails", async () => {
    const applyError = new Error("SQLite write failed");
    const { service, syncApi, syncMetadata, localStore } = createHarness();
    syncApi.pullChanges.mockResolvedValue({
      status: 200,
      body: {
        changes: [
          {
            resourceType: "entry",
            resourceId: "remote-entry",
            operation: "update",
            version: 2,
            resource: { id: "remote-entry", content: "Remote update" },
          },
        ],
        nextCursor: "cursor-next",
      },
    });
    localStore.applyRemoteChange.mockRejectedValue(applyError);

    await expect(service.pullChanges()).rejects.toBe(applyError);

    expect(syncMetadata.set).not.toHaveBeenCalled();
  });

  test("[REQ-F-036] rejects malformed pull responses without applying changes or advancing the cursor", async () => {
    const { service, syncApi, syncMetadata, localStore } = createHarness();
    syncApi.pullChanges.mockResolvedValue({
      status: 200,
      body: { changes: "not-an-array", nextCursor: "" },
    });

    await expect(service.pullChanges()).rejects.toThrow();

    expect(localStore.applyRemoteChange).not.toHaveBeenCalled();
    expect(syncMetadata.set).not.toHaveBeenCalled();
  });

  test("[REQ-F-036] preserves the saved cursor when the server reports an expired cursor", async () => {
    const { service, syncApi, syncMetadata, localStore } = createHarness({
      cursor: "expired-cursor",
    });
    syncApi.pullChanges.mockResolvedValue({
      status: 410,
      body: { code: "CURSOR_EXPIRED" },
    });

    await expect(service.pullChanges()).rejects.toThrow();

    expect(localStore.applyRemoteChange).not.toHaveBeenCalled();
    expect(syncMetadata.set).not.toHaveBeenCalled();
  });

  test("[REQ-F-037] preserves local and server versions when the server reports a conflict", async () => {
    const queuedChange = {
      id: 27,
      operation: "update",
      resourceType: "entry",
      resourceId: "entry-1",
      baseVersion: 4,
      payload: { id: "entry-1", content: "Local version" },
    };
    const conflict = {
      changeId: "27",
      localVersion: queuedChange.payload,
      serverVersion: { id: "entry-1", version: 5, content: "Server version" },
    };
    const { service, syncApi, conflicts, pendingChanges } = createHarness({
      queuedChanges: [queuedChange],
    });
    syncApi.pushChanges.mockResolvedValue({
      status: 409,
      body: { code: "VERSION_CONFLICT", conflict },
    });

    const result = await service.pushPendingChanges();

    expect(conflicts.save).toHaveBeenCalledWith({
      changeId: "27",
      resourceType: "entry",
      resourceId: "entry-1",
      localVersion: queuedChange.payload,
      serverVersion: conflict.serverVersion,
    });
    expect(pendingChanges.removeAcknowledged).not.toHaveBeenCalled();
    expect(result).toMatchObject({ conflicts: 1, remaining: 1 });
  });

  test.each(["local", "server"])(
    "[REQ-F-037] queues the selected %s version against the latest server version",
    async (selection) => {
      const localVersion = { id: "entry-1", content: "Local choice" };
      const serverVersion = { id: "entry-1", version: 5, content: "Server choice" };
      const conflict = {
        changeId: "27",
        resourceType: "entry",
        resourceId: "entry-1",
        localVersion,
        serverVersion,
      };
      const { service, conflicts, pendingChanges } = createHarness({ conflict });

      const resolution = await service.resolveConflict("27", selection);

      expect(pendingChanges.enqueue).toHaveBeenCalledWith({
        operation: "update",
        resourceType: "entry",
        resourceId: "entry-1",
        baseVersion: 5,
        payload: selection === "local" ? localVersion : serverVersion,
      });
      expect(conflicts.remove).toHaveBeenCalledWith("27");
      expect(resolution).toMatchObject({ selection, resourceId: "entry-1" });
    },
  );
});
