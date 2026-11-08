"use strict";

const SYNC_CURSOR_KEY = "syncCursor";
const SYNC_RESOURCE_TYPES = new Set([
  "entry",
  "book",
  "chapter",
  "tag",
  "entryTagAssociation",
  "entryBookAssociation",
  "entryChapterAssociation",
  "entryLink",
]);

function requireMethod(dependency, method, label) {
  if (!dependency || typeof dependency[method] !== "function") {
    throw new TypeError(`Synchronization requires ${label}.${method}().`);
  }
}

function requireValidSyncResponse(response, operation) {
  if (!response || !Number.isInteger(response.status)) {
    throw new TypeError(`${operation} returned an invalid response.`);
  }
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(
      response.body && response.body.detail
        ? response.body.detail
        : `${operation} failed with HTTP ${response.status}.`,
    );
    error.status = response.status;
    error.body = response.body;
    throw error;
  }
  if (!response.body || typeof response.body !== "object" || Array.isArray(response.body)) {
    throw new TypeError(`${operation} returned an invalid response body.`);
  }
  return response.body;
}

function validatePullChange(change) {
  if (
    !change ||
    !SYNC_RESOURCE_TYPES.has(change.resourceType) ||
    typeof change.resourceId !== "string" ||
    !change.resourceId.trim() ||
    !["create", "update", "delete"].includes(change.operation) ||
    !Number.isInteger(change.version) ||
    change.version < 1 ||
    (change.operation !== "delete" &&
      (!change.resource || typeof change.resource !== "object" || Array.isArray(change.resource)))
  ) {
    throw new TypeError("Pull response contains an invalid change.");
  }
}

function toOutboundResource(resourceType, resource) {
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    throw new TypeError("Pending change resource must be an object.");
  }
  if (!SYNC_RESOURCE_TYPES.has(resourceType)) {
    throw new TypeError(`Unsupported pending resource type ${resourceType}.`);
  }
  if (resourceType === "entry") {
    if (
      typeof resource.content !== "string" ||
      resource.content.trim().length === 0 ||
      ![
        "Character",
        "Scene",
        "Plot Idea",
        "World-building",
        "Dialogue/Phrase",
        "General Note",
      ].includes(resource.entryType)
    ) {
      throw new TypeError("Pending Entry resource does not match the OpenAPI contract.");
    }
    const result = {
      content: resource.content,
      entryType: resource.entryType,
    };
    if (typeof resource.title === "string" && resource.title.length > 0) {
      result.title = resource.title;
    }
    return result;
  }
  if (resourceType === "book" || resourceType === "chapter") {
    const title = resource.title || resource.name;
    if (typeof title !== "string" || title.trim().length === 0) {
      throw new TypeError(`Pending ${resourceType} resource requires a title.`);
    }
    const result = { title };
    if (resourceType === "chapter") {
      if (typeof resource.bookId !== "string" || resource.bookId.trim().length === 0) {
        throw new TypeError("Pending Chapter resource requires a bookId.");
      }
      result.bookId = resource.bookId;
    }
    return result;
  }
  if (resourceType === "tag") {
    if (typeof resource.name !== "string" || resource.name.trim().length === 0) {
      throw new TypeError("Pending Tag resource requires a name.");
    }
    return { name: resource.name };
  }
  if (resourceType === "entryTagAssociation") {
    if (
      typeof resource.entryId !== "string" ||
      !resource.entryId.trim() ||
      typeof resource.tagId !== "string" ||
      !resource.tagId.trim()
    ) {
      throw new TypeError("Pending Entry Tag Association requires entryId and tagId.");
    }
    return { entryId: resource.entryId, tagId: resource.tagId };
  } else if (resourceType === "entryBookAssociation") {
    if (
      typeof resource.entryId !== "string" ||
      !resource.entryId.trim() ||
      typeof resource.bookId !== "string" ||
      !resource.bookId.trim()
    ) {
      throw new TypeError("Pending Entry Book Association requires entryId and bookId.");
    }
    return { entryId: resource.entryId, bookId: resource.bookId };
  } else if (resourceType === "entryChapterAssociation") {
    if (
      typeof resource.entryId !== "string" ||
      !resource.entryId.trim() ||
      typeof resource.chapterId !== "string" ||
      !resource.chapterId.trim()
    ) {
      throw new TypeError("Pending Entry Chapter Association requires entryId and chapterId.");
    }
    return { entryId: resource.entryId, chapterId: resource.chapterId };
  }
  if (resourceType === "entryLink") {
    if (
      Array.isArray(resource.entryIds) &&
      resource.entryIds.length === 2 &&
      resource.entryIds.every((id) => typeof id === "string" && id.trim()) &&
      resource.entryIds[0] !== resource.entryIds[1]
    ) {
      return { entryIdA: resource.entryIds[0], entryIdB: resource.entryIds[1] };
    }
    if (
      typeof resource.entryIdA === "string" &&
      resource.entryIdA.trim() &&
      typeof resource.entryIdB === "string" &&
      resource.entryIdB.trim() &&
      resource.entryIdA !== resource.entryIdB
    ) {
      return { entryIdA: resource.entryIdA, entryIdB: resource.entryIdB };
    }
    throw new TypeError("Pending Entry Link requires two Entry IDs.");
  }
  throw new TypeError(`Unsupported pending resource type ${resourceType}.`);
}

async function toOutboundChange(change, syncMetadata, localStore) {
  const outbound = {
    changeId: String(change.id),
    resourceType: change.resourceType,
    operation: change.operation,
  };
  if (change.operation !== "create") {
    let baseVersion = change.baseVersion ?? change.payload?.version;
    if (baseVersion === undefined) {
      const savedVersion = await syncMetadata.get(
        `version:${change.resourceType}:${change.resourceId}`,
      );
      baseVersion = savedVersion === null ? undefined : Number(savedVersion);
    }
    if (!Number.isInteger(baseVersion) || baseVersion < 1) {
      throw new TypeError(`Pending change ${change.id} requires a positive baseVersion.`);
    }
    outbound.resourceId =
      typeof localStore.getRemoteResourceId === "function"
        ? await localStore.getRemoteResourceId(change.resourceType, change.resourceId)
        : change.resourceId;
    outbound.baseVersion = baseVersion;
  }
  if (change.operation !== "delete") {
    outbound.resource = toOutboundResource(change.resourceType, change.payload);
  }
  return outbound;
}

function createSynchronizationService({
  pendingChanges,
  syncMetadata,
  syncApi,
  localStore,
  conflicts,
  createId,
  auditLog,
  now = () => new Date(),
} = {}) {
  requireMethod(pendingChanges, "list", "Pending changes");
  requireMethod(pendingChanges, "removeAcknowledged", "Pending changes");
  requireMethod(pendingChanges, "enqueue", "Pending changes");
  requireMethod(syncMetadata, "get", "Sync metadata");
  requireMethod(syncMetadata, "set", "Sync metadata");
  requireMethod(syncApi, "pushChanges", "Sync API");
  requireMethod(syncApi, "pullChanges", "Sync API");
  requireMethod(localStore, "withTransactionAsync", "Local store");
  requireMethod(localStore, "applyRemoteChange", "Local store");
  requireMethod(conflicts, "save", "Conflicts");
  requireMethod(conflicts, "findByChangeId", "Conflicts");
  requireMethod(conflicts, "remove", "Conflicts");
  if (auditLog !== undefined) {
    requireMethod(auditLog, "record", "Audit log");
  }
  if (typeof createId !== "function") {
    throw new TypeError("Synchronization requires an ID factory.");
  }
  if (typeof now !== "function") {
    throw new TypeError("Synchronization requires a clock function.");
  }

  async function recordSyncEvent(event, detail) {
    if (!auditLog) {
      return;
    }
    const timestamp = now();
    if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
      throw new TypeError("Synchronization clock must return a valid Date.");
    }
    await auditLog.record({
      event,
      resourceId: "sync",
      occurredAt: timestamp.toISOString(),
      detail,
    });
  }

  async function withAudit(operation, work) {
    try {
      const result = await work();
      await recordSyncEvent(`sync.${operation}.completed`, result);
      return result;
    } catch (error) {
      await recordSyncEvent(`sync.${operation}.failed`, {
        errorType: error instanceof Error ? error.name : "UnknownError",
        status: Number.isInteger(error && error.status) ? error.status : null,
      });
      throw error;
    }
  }

  async function pushPendingChanges() {
    const queuedChanges = await pendingChanges.list();
    if (!Array.isArray(queuedChanges)) {
      throw new TypeError("Pending changes repository must return an array.");
    }
    if (queuedChanges.length === 0) {
      return { acknowledged: 0, conflicts: 0, remaining: 0 };
    }

    queuedChanges.forEach((change) => {
      if (
        !change ||
        !Number.isInteger(change.id) ||
        change.id < 1 ||
        typeof change.resourceType !== "string" ||
        !change.resourceType.trim() ||
        typeof change.resourceId !== "string" ||
        !change.resourceId.trim() ||
        !["create", "update", "delete"].includes(change.operation)
      ) {
        throw new TypeError("Pending change is not valid for synchronization.");
      }
      if (!SYNC_RESOURCE_TYPES.has(change.resourceType)) {
        throw new TypeError(`Unsupported pending resource type ${change.resourceType}.`);
      }
    });
    const changes = await Promise.all(
      queuedChanges.map((change) => toOutboundChange(change, syncMetadata, localStore)),
    );
    const signature = JSON.stringify(changes);
    const savedBatch = await syncMetadata.get("syncPushBatch");
    let batch;
    try {
      batch = savedBatch ? JSON.parse(savedBatch) : null;
    } catch (error) {
      throw new Error(`Saved synchronization batch is invalid: ${error.message}`);
    }
    const idempotencyKey =
      batch && batch.signature === signature ? batch.idempotencyKey : createId();
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
      throw new TypeError("ID factory must return a nonblank idempotency key.");
    }
    if (!batch || batch.signature !== signature) {
      await syncMetadata.set(
        "syncPushBatch",
        JSON.stringify({ signature, idempotencyKey }),
      );
    }
    const response = await syncApi.pushChanges(
      { changes },
      { idempotencyKey },
    );

    if (response && response.status === 409) {
      return saveVersionConflict(response.body, queuedChanges);
    }

    const body = requireValidSyncResponse(response, "Push changes");
    if (!Array.isArray(body.results)) {
      throw new TypeError("Push response results must be an array.");
    }

    const changeById = new Map(queuedChanges.map((change) => [String(change.id), change]));
    const acknowledgedIds = [];
    for (const result of body.results) {
      if (
        !result ||
        typeof result.changeId !== "string" ||
        result.status !== "acknowledged" ||
        typeof result.resourceId !== "string" ||
        !changeById.has(result.changeId) ||
        acknowledgedIds.includes(changeById.get(result.changeId).id)
      ) {
        throw new TypeError("Push response contains an invalid or duplicate acknowledgment.");
      }
      acknowledgedIds.push(changeById.get(result.changeId).id);
    }

    if (acknowledgedIds.length > 0) {
      for (const result of body.results) {
        const change = changeById.get(result.changeId);
        if (
          change.operation === "create" &&
          typeof localStore.rememberRemoteResourceId === "function"
        ) {
          await localStore.rememberRemoteResourceId(
            change.resourceType,
            change.resourceId,
            result.resourceId,
          );
        }
        if (result.version !== undefined) {
          if (!Number.isInteger(result.version) || result.version < 1) {
            throw new TypeError("Push response contains an invalid resource version.");
          }
          await syncMetadata.set(
            `version:${change.resourceType}:${change.resourceId}`,
            String(result.version),
          );
        }
      }
      await pendingChanges.removeAcknowledged(acknowledgedIds);
    }
    return {
      acknowledged: acknowledgedIds.length,
      conflicts: 0,
      remaining: queuedChanges.length - acknowledgedIds.length,
    };
  }

  async function saveVersionConflict(body, queuedChanges) {
    if (
      !body ||
      body.code !== "VERSION_CONFLICT" ||
      !body.conflict ||
      typeof body.conflict.changeId !== "string"
    ) {
      const error = new Error("Push failed with an unsupported conflict response.");
      error.status = 409;
      error.body = body;
      throw error;
    }
    const queuedChange = queuedChanges.find(
      (change) => String(change.id) === body.conflict.changeId,
    );
    if (
      !queuedChange ||
      !body.conflict.serverVersion ||
      !body.conflict.localVersion
    ) {
      throw new TypeError("Version conflict response does not match a queued change.");
    }
    await conflicts.save({
      changeId: body.conflict.changeId,
      resourceType: queuedChange.resourceType,
      resourceId: queuedChange.resourceId,
      localVersion: body.conflict.localVersion,
      serverVersion: body.conflict.serverVersion,
    });
    if (Number.isInteger(body.conflict.serverVersion.version)) {
      await syncMetadata.set(
        `version:${queuedChange.resourceType}:${queuedChange.resourceId}`,
        String(body.conflict.serverVersion.version),
      );
    }
    return {
      acknowledged: 0,
      conflicts: 1,
      remaining: queuedChanges.length,
    };
  }

  async function pullChanges() {
    const cursor = await syncMetadata.get(SYNC_CURSOR_KEY);
    const response = await syncApi.pullChanges(cursor);
    const body = requireValidSyncResponse(response, "Pull changes");
    if (
      !Array.isArray(body.changes) ||
      typeof body.nextCursor !== "string" ||
      body.nextCursor.trim().length === 0
    ) {
      throw new TypeError("Pull response must contain changes and a nonblank nextCursor.");
    }
    body.changes.forEach(validatePullChange);

    await localStore.withTransactionAsync(async () => {
      for (const change of body.changes) {
        await localStore.applyRemoteChange(change);
        const localResourceId =
          typeof localStore.getLocalResourceId === "function"
            ? await localStore.getLocalResourceId(change.resourceType, change.resourceId)
            : change.resourceId;
        await syncMetadata.set(
          `version:${change.resourceType}:${localResourceId}`,
          String(change.version),
        );
      }
      await syncMetadata.set(SYNC_CURSOR_KEY, body.nextCursor);
    });
    return { applied: body.changes.length, cursor: body.nextCursor };
  }

  async function resolveConflict(changeId, selection) {
    if (typeof changeId !== "string" || changeId.trim().length === 0) {
      throw new TypeError("Conflict change ID must be a nonblank string.");
    }
    if (selection !== "local" && selection !== "server") {
      throw new TypeError("Conflict selection must be local or server.");
    }
    const conflict = await conflicts.findByChangeId(changeId);
    if (!conflict) {
      throw new Error(`Conflict ${changeId} was not found.`);
    }
    const selectedVersion =
      selection === "local" ? conflict.localVersion : conflict.serverVersion;
    const baseVersion = conflict.serverVersion && conflict.serverVersion.version;
    if (!Number.isInteger(baseVersion) || baseVersion < 1) {
      throw new TypeError("Conflict server version must include a positive version number.");
    }
    await pendingChanges.enqueue({
      operation: "update",
      resourceType: conflict.resourceType,
      resourceId: conflict.resourceId,
      baseVersion,
      payload: selectedVersion,
    });
    await conflicts.remove(changeId);
    return { selection, resourceId: conflict.resourceId };
  }

  return {
    pushPendingChanges() {
      return withAudit("push", pushPendingChanges);
    },
    pullChanges() {
      return withAudit("pull", pullChanges);
    },
    resolveConflict,
  };
}

module.exports = {
  SYNC_CURSOR_KEY,
  createSynchronizationService,
};
