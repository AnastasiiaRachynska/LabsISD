"use strict";

const http = require("node:http");
const { randomUUID } = require("node:crypto");

const port = Number(process.env.PORT || 4011);
const staticToken = process.env.STATEFUL_MOCK_TOKEN || "schemathesis-test-token";
const now = () => new Date().toISOString();
const newId = (prefix) => `${prefix}-${randomUUID()}`;
const users = new Map();
const accessTokens = new Map();
const refreshTokens = new Map();
const stores = {
  entries: new Map(),
  books: new Map(),
  chapters: new Map(),
  tags: new Map(),
  entryTag: new Map(),
  entryBook: new Map(),
  entryChapter: new Map(),
  entryLinks: new Map(),
};
const syncLog = [];
const cursors = new Map();
const idempotencyKeys = new Map();

const seedUser = {
  userId: "mock-user",
  email: "writer@example.com",
  password: "ExamplePass123",
  createdAt: now(),
};
users.set(seedUser.email, seedUser);
accessTokens.set(staticToken, seedUser.userId);

function send(res, status, body, headers = {}, contentType = "application/json") {
  res.writeHead(
    status,
    status === 204 ? headers : { "Content-Type": `${contentType}; charset=utf-8`, ...headers },
  );
  res.end(body === undefined ? undefined : JSON.stringify(body));
  return true;
}

function problem(res, status, code, detail, extra = {}) {
  const titles = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    412: "Precondition Failed",
    415: "Unsupported Media Type",
    422: "Unprocessable Content",
    428: "Precondition Required",
    410: "Gone",
    500: "Internal Server Error",
  };
  return send(
    res,
    status,
    { type: "about:blank", title: titles[status] || "Error", status, code, detail, ...extra },
    {},
    "application/problem+json",
  );
}

function parseJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(Object.assign(new Error("Request body exceeds 1 MiB."), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(Object.assign(new Error("Request body is not valid JSON."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function validateObject(body, required, optional, stringFields = []) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "A JSON object is required.";
  if (Object.keys(body).some((key) => !required.includes(key) && !optional.includes(key))) {
    return "The request contains an unsupported field.";
  }
  if (required.some((key) => !Object.hasOwn(body, key))) return "A required field is missing.";
  if (stringFields.some((key) => Object.hasOwn(body, key) && typeof body[key] !== "string")) {
    return "One or more fields must be strings.";
  }
  return null;
}

function validateWrite(kind, body, partial = false) {
  const shapes = {
    entry: { required: ["content"], optional: ["title", "entryType"], strings: ["content", "title", "entryType"] },
    book: { required: ["title"], optional: [], strings: ["title"] },
    chapter: { required: ["title"], optional: [], strings: ["title"] },
    tag: { required: ["name"], optional: [], strings: ["name"] },
  };
  const shape = shapes[kind];
  const required = partial ? [] : shape.required;
  const optional = partial ? [...shape.required, ...shape.optional] : shape.optional;
  const error = validateObject(body, required, optional, shape.strings);
  if (error) return error;
  if (partial && Object.keys(body).length === 0) return "At least one field must be provided.";
  if (kind === "entry") {
    if (Object.hasOwn(body, "content") && !/\S/.test(body.content)) return "content must not be blank.";
    if (Object.hasOwn(body, "entryType") && !["Character", "Scene", "Plot Idea", "World-building", "Dialogue/Phrase", "General Note"].includes(body.entryType)) {
      return "entryType is not a supported value.";
    }
  }
  if ((kind === "book" || kind === "chapter") && Object.hasOwn(body, "title") && !/\S/.test(body.title)) {
    return "title must not be blank.";
  }
  if (kind === "tag" && Object.hasOwn(body, "name") && !/\S/.test(body.name)) return "name must not be blank.";
  return null;
}

function ownerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  return match ? accessTokens.get(match[1]) : undefined;
}

function requireOwner(req, res) {
  const userId = ownerToken(req);
  if (!userId) {
    problem(res, 401, "UNAUTHORIZED", "A valid Bearer access token is required.");
    return undefined;
  }
  return userId;
}

function visibleRecord(store, id, userId, res) {
  const record = store.get(id);
  if (!record) {
    problem(res, 404, "RESOURCE_NOT_FOUND", "The requested resource was not found.");
    return undefined;
  }
  if (record.ownerId !== userId) {
    problem(res, 403, "FORBIDDEN", "The resource belongs to another user.");
    return undefined;
  }
  return record;
}

function makeResource(kind, body, ownerId, parent = {}) {
  const timestamp = now();
  const id = newId(kind);
  const resource = {
    id,
    version: 1,
    ...parent,
    ...(kind === "entry"
      ? {
          content: body.content,
          title: body.title || null,
          displayTitle: body.title?.trim() || body.content.trim().slice(0, 80),
          entryType: body.entryType || "General Note",
        }
      : kind === "tag"
        ? { name: body.name }
        : { title: body.title }),
    createdAt: timestamp,
    updatedAt: timestamp,
    ownerId,
  };
  return resource;
}

function publicRecord(record) {
  const { ownerId, ...body } = record;
  return body;
}

function requireIfMatch(req, res, record) {
  const value = req.headers["if-match"];
  if (value === undefined) {
    problem(res, 428, "PRECONDITION_REQUIRED", "The If-Match header is required.");
    return false;
  }
  const match = /^"(\d+)"$/.exec(value);
  if (!match) {
    problem(res, 400, "INVALID_IF_MATCH", 'If-Match must contain a quoted resource version, such as "1".');
    return false;
  }
  if (Number(match[1]) !== record.version) {
    problem(res, 412, "PRECONDITION_FAILED", "The resource has changed since it was read.");
    return false;
  }
  return true;
}

function resourceResponse(res, status, record, location) {
  const headers = { ETag: `"${record.version}"` };
  if (location) headers.Location = location;
  return send(res, status, publicRecord(record), headers);
}

function pageRecords(url, items, res) {
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue === null ? 50 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return problem(res, 400, "INVALID_PAGINATION", "limit must be an integer between 1 and 100.");
  }
  const cursor = url.searchParams.get("cursor");
  let offset = 0;
  if (cursor !== null) {
    const match = /^page-(\d+)$/.exec(cursor);
    if (!match) {
      return problem(res, 400, "INVALID_CURSOR", "The collection cursor is invalid.");
    }
    offset = Number(match[1]);
  }
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return send(res, 200, {
    items: page.map(publicRecord),
    nextCursor: nextOffset < items.length ? `page-${nextOffset}` : null,
  });
}

function recordChange(userId, kind, operation, resource) {
  syncLog.push({
    userId,
    resourceType: kind,
    resourceId: resource.id,
    operation,
    version: resource.version,
    resource: operation === "delete" ? undefined : publicRecord(resource),
  });
}

function listResource(req, res, url, kind, store, filter = () => true) {
  const userId = requireOwner(req, res);
  if (!userId) return true;
  return pageRecords(
    url,
    [...store.values()].filter((item) => item.ownerId === userId && filter(item)),
    res,
  );
}

function handleResource(req, res, url, segments, userId, kind, store, parent = {}) {
  const [id] = segments;
  if (!id) {
    if (req.method === "GET") return listResource(req, res, url, kind, store);
    if (req.method !== "POST") return methodNotAllowed(req, res, ["GET", "POST"]);
    return parseJson(req).then((body) => {
      const error = validateWrite(kind, body);
      if (error) return problem(res, 422, "VALIDATION_ERROR", error);
      if (parent.bookId && !visibleRecord(stores.books, parent.bookId, userId, res)) return;
      const record = makeResource(kind, body, userId, parent);
      store.set(record.id, record);
      recordChange(userId, kind, "create", record);
      resourceResponse(res, 201, record, `${url.pathname}/${record.id}`);
    });
  }
  if (segments.length > 1) return methodNotAllowed(req, res, ["GET", "PUT", "PATCH", "DELETE"]);
  const record = visibleRecord(store, id, userId, res);
  if (!record) return;
  if (parent.bookId && record.bookId !== parent.bookId) {
    problem(res, 404, "RESOURCE_NOT_FOUND", "The requested Chapter was not found in this Book.");
    return;
  }
  if (req.method === "GET") return resourceResponse(res, 200, record);
  if (!["PUT", "PATCH", "DELETE"].includes(req.method)) {
    return methodNotAllowed(req, res, ["GET", "PUT", "PATCH", "DELETE"]);
  }
  if (!requireIfMatch(req, res, record)) return;
  if (req.method === "DELETE") {
    store.delete(id);
    removeRelationships(kind, id);
    recordChange(userId, kind, "delete", record);
    return send(res, 204);
  }
  return parseJson(req).then((body) => {
    const error = validateWrite(kind, body, req.method === "PATCH");
    if (error) return problem(res, 422, "VALIDATION_ERROR", error);
    const next = { ...record, ...body, version: record.version + 1, updatedAt: now() };
    if (kind === "entry") {
      if (req.method === "PUT") {
        next.title = body.title || null;
        next.entryType = body.entryType || "General Note";
      }
      next.title = next.title || null;
      next.displayTitle = next.title?.trim() || next.content.trim().slice(0, 80);
    }
    store.set(id, next);
    recordChange(userId, kind, "update", next);
    resourceResponse(res, 200, next);
  });
}

function removeRelationships(kind, id) {
  const matches = (association) =>
    (kind === "entry" && (association.entryId === id || association.entryIds?.includes(id))) ||
    (kind === "book" && association.bookId === id) ||
    (kind === "chapter" && association.chapterId === id) ||
    (kind === "tag" && association.tagId === id);
  for (const store of [stores.entryTag, stores.entryBook, stores.entryChapter, stores.entryLinks]) {
    for (const [key, association] of store) if (matches(association)) store.delete(key);
  }
  if (kind === "book") {
    for (const [chapterId, chapter] of stores.chapters) {
      if (chapter.bookId === id) {
        stores.chapters.delete(chapterId);
        removeRelationships("chapter", chapterId);
      }
    }
  }
}

function handleAssociation(req, res, url, userId, type, store, fields, filterFields = fields) {
  const segments = url.pathname.split("/").filter(Boolean);
  const id = segments[3];
  if (!id) {
    if (req.method === "GET") {
      if (filterFields.some((field) => url.searchParams.has(field) && url.searchParams.get(field).length === 0)) {
        return problem(res, 400, "INVALID_FILTER", "Association filters must not be empty.");
      }
      const filtered = [...store.values()].filter((item) =>
        item.ownerId === userId &&
        filterFields.every((field) => !url.searchParams.has(field) || item[field] === url.searchParams.get(field)),
      );
      return pageRecords(url, filtered, res);
    }
    if (req.method !== "POST") return methodNotAllowed(req, res, ["GET", "POST"]);
    return parseJson(req).then((body) => {
      const error = validateObject(body, fields, [], fields);
      if (error) return problem(res, 422, "VALIDATION_ERROR", error);
      for (const field of fields) {
        const storeName = field === "entryId" ? "entries" :
          field === "tagId" ? "tags" :
            field === "bookId" ? "books" : field === "chapterId" ? "chapters" : null;
        if (storeName && !visibleRecord(stores[storeName], body[field], userId, res)) return;
      }
      if (type === "entryChapter") {
        body.bookId = stores.chapters.get(body.chapterId).bookId;
      }
      const duplicate = [...store.values()].some((item) =>
        item.ownerId === userId && fields.every((field) => item[field] === body[field]),
      );
      if (duplicate) return problem(res, 409, "DUPLICATE_RELATIONSHIP", "This relationship already exists.");
      const item = { id: newId(type), ...body, ...(type === "entryBook" ? { source: "direct" } : {}), ownerId: userId };
      store.set(item.id, item);
      const { ownerId, ...response } = item;
      return send(res, 201, response, { Location: `${url.pathname}/${item.id}` });
    });
  }
  if (segments.length !== 4 || req.method !== "DELETE") return methodNotAllowed(req, res, ["DELETE"]);
  const item = visibleRecord(store, id, userId, res);
  if (!item) return;
  store.delete(id);
  send(res, 204);
}

function handleEntryLinks(req, res, url, userId) {
  const segments = url.pathname.split("/").filter(Boolean);
  const id = segments[3];
  if (!id && req.method === "GET") {
    if (url.searchParams.has("entryId") && url.searchParams.get("entryId").length === 0) {
      return problem(res, 400, "INVALID_FILTER", "entryId must not be empty.");
    }
    return listResource(req, res, url, "entryLink", stores.entryLinks, (item) => {
      const entryId = url.searchParams.get("entryId");
      return !entryId || item.entryIds.includes(entryId);
    });
  }
  if (!id && req.method === "POST") {
    return parseJson(req).then((body) => {
      const error = validateObject(body, ["entryIdA", "entryIdB"], [], ["entryIdA", "entryIdB"]);
      if (error) return problem(res, 422, "VALIDATION_ERROR", error);
      if (body.entryIdA === body.entryIdB) return problem(res, 422, "VALIDATION_ERROR", "An Entry Link must connect two different Entries.");
      if (!visibleRecord(stores.entries, body.entryIdA, userId, res) || !visibleRecord(stores.entries, body.entryIdB, userId, res)) return;
      const entryIds = [body.entryIdA, body.entryIdB].sort();
      const duplicate = [...stores.entryLinks.values()].some((link) =>
        link.ownerId === userId && link.entryIds[0] === entryIds[0] && link.entryIds[1] === entryIds[1],
      );
      if (duplicate) return problem(res, 409, "DUPLICATE_RELATIONSHIP", "This Entry Link already exists.");
      const link = { id: newId("link"), entryIds, ownerId: userId };
      stores.entryLinks.set(link.id, link);
      return send(res, 201, { id: link.id, entryIds }, { Location: `${url.pathname}/${link.id}` });
    });
  }
  if (id && req.method === "DELETE") {
    const link = visibleRecord(stores.entryLinks, id, userId, res);
    if (!link) return;
    stores.entryLinks.delete(id);
    return send(res, 204);
  }
  return methodNotAllowed(req, res, id ? ["DELETE"] : ["GET", "POST"]);
}

function publicUser(user) {
  const { password, ...result } = user;
  return result;
}

function tokenResponse(user) {
  const accessToken = `access-${randomUUID()}`;
  const refreshToken = `refresh-${randomUUID()}`;
  accessTokens.set(accessToken, user.userId);
  refreshTokens.set(refreshToken, user.userId);
  return { tokenType: "Bearer", accessToken, accessTokenExpiresIn: 900, refreshToken, user: publicUser(user) };
}

function handleAuth(req, res, url, userId) {
  if (url.pathname === "/api/v1/auth/register" && req.method === "POST") {
    return parseJson(req).then((body) => {
      const error = validateObject(body, ["email", "password"], [], ["email", "password"]);
      if (error || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(body.email) || [...body.password].length < 8) {
        return problem(res, 422, "VALIDATION_ERROR", error || "A valid email and a password of at least 8 characters are required.");
      }
      const email = body.email.toLowerCase();
      if (users.has(email)) return problem(res, 409, "EMAIL_ALREADY_REGISTERED", "An account with this email address already exists.");
      const user = { userId: newId("user"), email, password: body.password, createdAt: now() };
      users.set(email, user);
      return send(res, 201, { user: publicUser(user) });
    });
  }
  if (url.pathname === "/api/v1/auth/login" && req.method === "POST") {
    return parseJson(req).then((body) => {
      const error = validateObject(body, ["email", "password"], [], ["email", "password"]);
      if (error || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(body.email) || [...body.password].length < 8) {
        return problem(res, 422, "VALIDATION_ERROR", error || "A valid email and a password of at least 8 characters are required.");
      }
      const user = users.get(body.email.toLowerCase());
      if (!user || user.password !== body.password) return problem(res, 401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
      return send(res, 200, tokenResponse(user));
    });
  }
  if (url.pathname === "/api/v1/auth/refresh" && req.method === "POST") {
    return parseJson(req).then((body) => {
      const error = validateObject(body, ["refreshToken"], [], ["refreshToken"]);
      if (error) return problem(res, 422, "VALIDATION_ERROR", error);
      const ownerId = refreshTokens.get(body.refreshToken);
      if (!ownerId) return problem(res, 401, "INVALID_REFRESH_TOKEN", "The refresh token is invalid or expired.");
      refreshTokens.delete(body.refreshToken);
      const user = [...users.values()].find((item) => item.userId === ownerId);
      return send(res, 200, tokenResponse(user));
    });
  }
  if (url.pathname === "/api/v1/auth/me" && req.method === "GET") {
    const user = [...users.values()].find((item) => item.userId === userId);
    return send(res, 200, publicUser(user));
  }
  return undefined;
}

function handleSync(req, res, url, userId) {
  if (url.pathname === "/api/v1/sync/push" && req.method === "POST") {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !key.trim()) {
      return problem(res, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header is required.");
    }
    return parseJson(req).then((body) => {
      const error = validateObject(body, ["changes"], [], []);
      if (error || !Array.isArray(body.changes)) return problem(res, 422, "VALIDATION_ERROR", error || "changes must be an array.");
      const requestHash = JSON.stringify(body);
      const scopedKey = `${userId}:${key}`;
      const previous = idempotencyKeys.get(scopedKey);
      if (previous) {
        if (previous.requestHash !== requestHash) {
          return problem(
            res,
            409,
            "IDEMPOTENCY_KEY_CONFLICT",
            "The Idempotency-Key was already used with a different request.",
            { idempotencyKey: key },
          );
        }
        return send(res, 200, previous.response);
      }
      const results = [];
      for (const change of body.changes) {
        const resourceTypes = ["entry", "book", "chapter", "tag", "entryTagAssociation", "entryBookAssociation", "entryChapterAssociation", "entryLink"];
        const operationFields = {
          create: { required: ["changeId", "resourceType", "operation", "resource"], optional: [] },
          update: { required: ["changeId", "resourceType", "operation", "resourceId", "baseVersion", "resource"], optional: [] },
          delete: { required: ["changeId", "resourceType", "operation", "resourceId", "baseVersion"], optional: [] },
        };
        const shape = change && operationFields[change.operation];
        const changeError = shape
          ? validateObject(change, shape.required, shape.optional, ["changeId", "resourceType", "operation", "resourceId"])
          : "Each change must use create, update, or delete.";
        if (changeError || !change.changeId || !resourceTypes.includes(change.resourceType) ||
            (Object.hasOwn(change, "resourceId") && !change.resourceId) ||
            (Object.hasOwn(change, "resource") &&
              (!change.resource || typeof change.resource !== "object" || Array.isArray(change.resource))) ||
            (["update", "delete"].includes(change.operation) &&
              (!Number.isInteger(change.baseVersion) || change.baseVersion < 1))) {
          return problem(res, 422, "VALIDATION_ERROR", "Each change must have a valid ID, resource type, and operation.");
        }
        const id = change.resourceId || change.resource?.id || newId(change.resourceType.toLowerCase());
        const result = { changeId: change.changeId, status: "acknowledged", resourceId: id };
        if (Number.isInteger(change.baseVersion)) result.version = change.baseVersion + 1;
        results.push(result);
        syncLog.push({
          userId,
          resourceType: change.resourceType,
          resourceId: id,
          operation: change.operation,
          version: result.version || 1,
          resource: change.operation === "delete" ? undefined : change.resource,
        });
      }
      const response = { results };
      idempotencyKeys.set(scopedKey, { requestHash, response });
      return send(res, 200, response);
    });
  }
  if (url.pathname === "/api/v1/sync/pull" && req.method === "GET") {
    const cursor = url.searchParams.get("cursor");
    let offset = 0;
    if (cursor !== null) {
      if (cursor.length === 0) return problem(res, 400, "INVALID_CURSOR", "cursor must not be empty.");
      const cursorState = cursors.get(cursor);
      if (!cursorState || cursorState.userId !== userId) {
        return problem(res, 410, "CURSOR_EXPIRED", "The cursor is invalid or expired; perform a full resynchronization.");
      }
      offset = cursorState.offset;
    }
    const changes = syncLog.filter((change) => change.userId === userId).slice(offset);
    const nextCursor = `sync-${randomUUID()}`;
    cursors.set(nextCursor, { userId, offset: offset + changes.length });
    return send(res, 200, {
      changes: changes.map(({ userId: ignored, ...change }) => change),
      nextCursor,
    });
  }
  return undefined;
}

function methodNotAllowed(req, res, methods) {
  send(res, 405, { type: "about:blank", title: "Method Not Allowed", status: 405, code: "METHOD_NOT_ALLOWED", detail: "The HTTP method is not supported for this resource." }, { Allow: methods.join(", ") }, "application/problem+json");
}

function supportedMethods(pathname) {
  if (pathname === "/api/v1/auth/register" || pathname === "/api/v1/auth/login" || pathname === "/api/v1/auth/refresh") return ["POST"];
  if (pathname === "/api/v1/auth/me") return ["GET"];
  if (pathname === "/api/v1/entries" || pathname === "/api/v1/books" || pathname === "/api/v1/tags") return ["GET", "POST"];
  if (/^\/api\/v1\/(?:entries|books|tags)\/[^/]+$/.test(pathname)) return ["GET", "PUT", "PATCH", "DELETE"];
  if (/^\/api\/v1\/books\/[^/]+\/chapters$/.test(pathname)) return ["GET", "POST"];
  if (/^\/api\/v1\/books\/[^/]+\/chapters\/[^/]+$/.test(pathname)) return ["GET", "PUT", "PATCH", "DELETE"];
  if (/^\/api\/v1\/(?:entry-tag-associations|entry-book-associations|entry-chapter-associations|entry-links)$/.test(pathname)) return ["GET", "POST"];
  if (/^\/api\/v1\/(?:entry-tag-associations|entry-book-associations|entry-chapter-associations|entry-links)\/[^/]+$/.test(pathname)) return ["DELETE"];
  if (pathname === "/api/v1/sync/push") return ["POST"];
  if (pathname === "/api/v1/sync/pull") return ["GET"];
  return undefined;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const authRoute = url.pathname.startsWith("/api/v1/auth/");
  const userId = authRoute && url.pathname !== "/api/v1/auth/me" ? undefined : requireOwner(req, res);
  if (!authRoute && !userId) return;
  const methods = supportedMethods(url.pathname);
  if (!methods) return problem(res, 404, "ROUTE_NOT_FOUND", "No API operation matches this path.");
  if (!methods.includes(req.method)) return methodNotAllowed(req, res, methods);
  if (authRoute) {
    if (url.pathname === "/api/v1/auth/me" && !userId) return;
    if (req.method === "POST" && !req.headers["content-type"]?.toLowerCase().includes("application/json")) {
      return problem(res, 415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
    }
    const response = await handleAuth(req, res, url, userId);
    if (response !== undefined) return response;
    return methodNotAllowed(req, res, url.pathname === "/api/v1/auth/me" ? ["GET"] : ["POST"]);
  }

  const hasBody = ["POST", "PUT", "PATCH"].includes(req.method);
  if (hasBody && !req.headers["content-type"]?.toLowerCase().includes("application/json")) {
    return problem(res, 415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
  }
  if (url.pathname === "/api/v1/entries" || url.pathname.startsWith("/api/v1/entries/")) {
    return handleResource(req, res, url, url.pathname.split("/").filter(Boolean).slice(3), userId, "entry", stores.entries);
  }
  if (url.pathname === "/api/v1/books" || /^\/api\/v1\/books\/[^/]+$/.test(url.pathname)) {
    return handleResource(req, res, url, url.pathname.split("/").filter(Boolean).slice(3), userId, "book", stores.books);
  }
  const chapters = /^\/api\/v1\/books\/([^/]+)\/chapters(?:\/([^/]+))?$/.exec(url.pathname);
  if (chapters) {
    const [, bookId, chapterId] = chapters;
    const book = visibleRecord(stores.books, bookId, userId, res);
    if (!book) return;
    return handleResource(req, res, url, chapterId ? [chapterId] : [], userId, "chapter", stores.chapters, { bookId });
  }
  if (url.pathname === "/api/v1/tags" || url.pathname.startsWith("/api/v1/tags/")) {
    return handleResource(req, res, url, url.pathname.split("/").filter(Boolean).slice(3), userId, "tag", stores.tags);
  }
  const associationRoutes = {
    "entry-tag-associations": ["entryTag", stores.entryTag, ["entryId", "tagId"], ["entryId", "tagId"]],
    "entry-book-associations": ["entryBook", stores.entryBook, ["entryId", "bookId"], ["entryId", "bookId"]],
    "entry-chapter-associations": ["entryChapter", stores.entryChapter, ["entryId", "chapterId"], ["entryId", "bookId", "chapterId"]],
  };
  const associationRoute = /^\/api\/v1\/([^/]+)(?:\/[^/]+)?$/.exec(url.pathname);
  if (associationRoute && associationRoutes[associationRoute[1]]) {
    const [type, store, fields, filterFields] = associationRoutes[associationRoute[1]];
    return handleAssociation(req, res, url, userId, type, store, fields, filterFields);
  }
  if (url.pathname === "/api/v1/entry-links" || url.pathname.startsWith("/api/v1/entry-links/")) {
    return handleEntryLinks(req, res, url, userId);
  }
  if (url.pathname === "/api/v1/sync/push" || url.pathname === "/api/v1/sync/pull") {
    const response = await handleSync(req, res, url, userId);
    if (response !== undefined) return response;
    return methodNotAllowed(req, res, url.pathname.endsWith("push") ? ["POST"] : ["GET"]);
  }
  return problem(res, 404, "ROUTE_NOT_FOUND", "No API operation matches this path.");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (!error.status) console.error("Stateful mock request failed:", error);
    if (!res.headersSent) {
      problem(res, error.status || 500, error.status ? "INVALID_REQUEST" : "MOCK_INTERNAL_ERROR", error.message || "An unexpected mock server error occurred.");
    } else {
      console.error("Stateful mock request failed:", error);
      res.destroy(error);
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Stateful contract mock listening at http://127.0.0.1:${port}`);
  console.log(`Seed user: writer@example.com / ExamplePass123`);
  console.log(`Schemathesis token: ${staticToken}`);
});
