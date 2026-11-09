"use strict";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const supportsNodeSqlite = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5);
const integrationTest = supportsNodeSqlite ? test : test.skip;

integrationTest("syncs local and remote Entries through the authenticated WNT-11 API", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { randomUUID } = require("node:crypto");
  const { DatabaseSync } = require("node:sqlite");
  const { createApplication } = require("../src/bootstrap/create-application");
  const { startApiServer } = require("../src/wnt11");
  const { createApiSession } = require("../src/wnt12/api-session");
  const { createSyncApi } = require("../src/wnt12/sync-api");

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "labsisd-app-sync-"));
  const rawDatabase = new DatabaseSync(path.join(temporaryDirectory, "local.db"));
  const database = {
    execAsync: async (sql) => rawDatabase.exec(sql),
    runAsync: async (sql, ...parameters) => rawDatabase.prepare(sql).run(...parameters),
    getFirstAsync: async (sql, ...parameters) =>
      rawDatabase.prepare(sql).get(...parameters) ?? null,
    getAllAsync: async (sql, ...parameters) => rawDatabase.prepare(sql).all(...parameters),
    withTransactionAsync: async (work) => {
      rawDatabase.exec("BEGIN;");
      try {
        const result = await work();
        rawDatabase.exec("COMMIT;");
        return result;
      } catch (error) {
        rawDatabase.exec("ROLLBACK;");
        throw error;
      }
    },
  };
  const secureValues = new Map();
  const secureStore = {
    getItemAsync: async (key) => secureValues.get(key) || null,
    setItemAsync: async (key, value) => secureValues.set(key, value),
    deleteItemAsync: async (key) => secureValues.delete(key),
  };
  let apiServer;

  try {
    apiServer = await startApiServer({
      databasePath: ":memory:",
      secret: "wnt12-app-integration-signing-secret",
      host: "127.0.0.1",
      port: 0,
      logger: () => {},
    });
    const baseUrl = `http://127.0.0.1:${apiServer.server.address().port}`;
    const apiSession = createApiSession({ secureStore });
    await apiSession.setBaseUrl(baseUrl);
    await apiSession.register(`sync-${randomUUID()}@example.test`, "IntegrationPass123");
    const syncApi = createSyncApi({
      getBaseUrl: () => apiSession.getBaseUrl(),
      getAccessToken: () => apiSession.getAccessToken(),
    });
    let nextId = 0;
    const application = await createApplication({
      openDatabase: async () => database,
      createId: () => `app-sync-${++nextId}`,
      syncApi,
    });

    const localEntry = await application.entryCapture.createEntry({
      content: "Created offline and uploaded through the app sync client.",
      entryType: "General Note",
    });
    await expect(application.synchronization.pushPendingChanges()).resolves.toMatchObject({
      acknowledged: 1,
      conflicts: 0,
      remaining: 0,
    });
    const mapping = await database.getFirstAsync(
      "SELECT remote_id FROM sync_resource_ids WHERE resource_type = 'entry' AND local_id = ?;",
      localEntry.id,
    );
    expect(mapping).toBeTruthy();

    const accessToken = await apiSession.getAccessToken();
    const authorization = ["Bear", "er ", accessToken].join("");
    const uploadedResponse = await fetch(`${baseUrl}/api/v1/entries/${mapping.remote_id}`, {
      headers: { Authorization: authorization },
    });
    expect(uploadedResponse.status).toBe(200);
    await expect(uploadedResponse.json()).resolves.toMatchObject({
      content: localEntry.content,
      entryType: "General Note",
    });

    const remotePush = await syncApi.pushChanges({
      changes: [{
        changeId: "remote-change-1",
        clientResourceId: "remote-client-entry",
        resourceType: "entry",
        operation: "create",
        resource: {
          content: "Created on the server and downloaded by the app.",
          entryType: "Scene",
        },
      }],
    }, { idempotencyKey: "remote-push-1" });
    expect(remotePush.status).toBe(200);
    const remoteEntryId = remotePush.body.results[0].resourceId;
    await expect(application.synchronization.pullChanges()).resolves.toMatchObject({
      applied: expect.any(Number),
    });
    await expect(application.repositories.entries.findById(remoteEntryId)).resolves.toMatchObject({
      id: remoteEntryId,
      content: "Created on the server and downloaded by the app.",
      entryType: "Scene",
    });
  } finally {
    rawDatabase.close();
    if (apiServer) {
      await apiServer.close();
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
