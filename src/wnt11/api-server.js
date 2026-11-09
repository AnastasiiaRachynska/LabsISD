"use strict";

const {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} = require("node:crypto");
const { promisify } = require("node:util");
const { createServer } = require("node:http");

const scryptAsync = promisify(scrypt);
const ACCESS_TOKEN_LIFETIME_SECONDS = 900;
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const ENTRY_TYPES = new Set([
  "Character",
  "Scene",
  "Plot Idea",
  "World-building",
  "Dialogue/Phrase",
  "General Note",
]);
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
const RESOURCE_DEFINITIONS = {
  entries: {
    table: "entries",
    fields: ["content", "title", "entryType"],
    required: ["content"],
    toJson: (row) => ({
      id: row.id,
      version: row.version,
      content: row.content,
      title: row.title,
      displayTitle: row.display_title,
      entryType: row.entry_type,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  },
  books: {
    table: "books",
    fields: ["title"],
    required: ["title"],
    toJson: (row) => ({
      id: row.id,
      version: row.version,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  },
  chapters: {
    table: "chapters",
    fields: ["title"],
    required: ["title"],
    toJson: (row) => ({
      id: row.id,
      version: row.version,
      bookId: row.book_id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  },
  tags: {
    table: "tags",
    fields: ["name"],
    required: ["name"],
    toJson: (row) => ({
      id: row.id,
      version: row.version,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  },
};
const ASSOCIATION_DEFINITIONS = {
  "entry-tag-associations": {
    table: "entry_tag_associations",
    fields: ["entryId", "tagId"],
    filters: ["entryId", "tagId"],
    columns: ["entry_id", "tag_id"],
    toJson: (row) => ({ id: row.id, entryId: row.entry_id, tagId: row.tag_id }),
  },
  "entry-book-associations": {
    table: "entry_book_associations",
    fields: ["entryId", "bookId"],
    filters: ["entryId", "bookId"],
    columns: ["entry_id", "book_id"],
    toJson: (row) => ({
      id: row.id,
      entryId: row.entry_id,
      bookId: row.book_id,
      source: "direct",
    }),
  },
  "entry-chapter-associations": {
    table: "entry_chapter_associations",
    fields: ["entryId", "chapterId"],
    filters: ["entryId", "bookId", "chapterId"],
    columns: ["entry_id", "chapter_id"],
    toJson: (row) => ({
      id: row.id,
      entryId: row.entry_id,
      chapterId: row.chapter_id,
      bookId: row.book_id,
    }),
  },
};

class ApiError extends Error {
  constructor(status, code, detail, title, extra = {}) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.title = title || titleForStatus(status);
    this.extra = extra;
  }
}

function titleForStatus(status) {
  return ({
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    409: "Conflict",
    412: "Precondition Failed",
    413: "Payload Too Large",
    415: "Unsupported Media Type",
    422: "Unprocessable Entity",
    428: "Precondition Required",
  })[status] || "Internal Server Error";
}

function fail(status, code, detail, title, extra) {
  throw new ApiError(status, code, detail, title, extra);
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function sendProblem(response, error, requestId) {
  const status = error instanceof ApiError ? error.status : 500;
  const body = {
    type: "about:blank",
    title: error instanceof ApiError ? error.title : "Internal Server Error",
    status,
    code: error instanceof ApiError ? error.code : "INTERNAL_ERROR",
    detail: error instanceof ApiError ? error.message : "The request could not be completed.",
    requestId,
    ...(error instanceof ApiError ? error.extra : {}),
  };
  response.writeHead(status, { "Content-Type": "application/problem+json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const contentType = request.headers["content-type"] || "";
  if (contentType.toLowerCase().split(";")[0].trim() !== "application/json") {
    fail(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      fail(413, "PAYLOAD_TOO_LARGE", "The request body exceeds the 1 MiB limit.");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    fail(400, "BAD_REQUEST", "A JSON request body is required.");
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail(400, "BAD_REQUEST", "The request body is not valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    fail(422, "VALIDATION_ERROR", "The request body must be a JSON object.");
  }
  return body;
}

function validateObject(body, required, allowed, stringFields = []) {
  const unsupported = Object.keys(body).find((key) => !allowed.includes(key));
  if (unsupported) {
    fail(422, "VALIDATION_ERROR", `The request contains unsupported field: ${unsupported}.`);
  }
  const missing = required.find((key) => !Object.hasOwn(body, key));
  if (missing) {
    fail(422, "VALIDATION_ERROR", `The required field ${missing} is missing.`);
  }
  const invalid = stringFields.find(
    (key) => Object.hasOwn(body, key) && typeof body[key] !== "string",
  );
  if (invalid) {
    fail(422, "VALIDATION_ERROR", `${invalid} must be a string.`);
  }
}

function validateResourceBody(kind, body, partial) {
  const definition = RESOURCE_DEFINITIONS[kind];
  const required = partial ? [] : definition.required;
  if (partial && Object.keys(body).length === 0) {
    fail(422, "VALIDATION_ERROR", "At least one field must be provided.");
  }
  validateObject(body, required, definition.fields, definition.fields);

  if (kind === "entries") {
    if (Object.hasOwn(body, "content") && body.content.trim().length === 0) {
      fail(422, "VALIDATION_ERROR", "content must not be blank.");
    }
    if (Object.hasOwn(body, "entryType") && !ENTRY_TYPES.has(body.entryType)) {
      fail(422, "VALIDATION_ERROR", "entryType is not a supported value.");
    }
    return;
  }

  const name = kind === "tags" ? "name" : "title";
  if (Object.hasOwn(body, name) && body[name].trim().length === 0) {
    fail(422, "VALIDATION_ERROR", `${name} must not be blank.`);
  }
}

function deriveDisplayTitle(content, title) {
  if (typeof title === "string" && title.trim().length > 0) {
    return { title, displayTitle: title };
  }
  const first25Characters = content.slice(0, 25);
  const newlineIndex = first25Characters.indexOf("\n");
  const displayTitle = newlineIndex >= 0
    ? `${first25Characters.slice(0, newlineIndex)}...`
    : content.length > 25
      ? `${first25Characters}...`
      : first25Characters;
  return { title: null, displayTitle };
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function createAccessToken(userId, secret, now) {
  const issuedAt = Math.floor(now().getTime() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = encodeBase64Url(JSON.stringify({
    sub: userId,
    iat: issuedAt,
    exp: issuedAt + ACCESS_TOKEN_LIFETIME_SECONDS,
  }));
  const input = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(input).digest("base64url");
  return `${input}.${signature}`;
}

function verifyAccessToken(token, secret, now) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const input = `${parts[0]}.${parts[1]}`;
  const expected = createHmac("sha256", secret).update(input).digest();
  let actual;
  let payload;
  try {
    actual = Buffer.from(parts[2], "base64url");
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }
  const currentTime = Math.floor(now().getTime() / 1000);
  if (
    typeof payload.sub !== "string" ||
    !Number.isInteger(payload.exp) ||
    payload.exp <= currentTime
  ) {
    return null;
  }
  return payload.sub;
}

function makeTokenResponse(database, user, secret, now) {
  const accessToken = createAccessToken(user.user_id, secret, now);
  const refreshToken = randomBytes(32).toString("base64url");
  const expiresAt = now().getTime() + REFRESH_TOKEN_LIFETIME_MS;
  database.prepare(
    "INSERT INTO refresh_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?);",
  ).run(hashToken(refreshToken), user.user_id, expiresAt);
  return {
    tokenType: "Bearer",
    accessToken,
    accessTokenExpiresIn: ACCESS_TOKEN_LIFETIME_SECONDS,
    refreshToken,
    user: publicUser(user),
  };
}

function publicUser(user) {
  return {
    userId: user.user_id,
    email: user.email,
    createdAt: user.created_at,
  };
}

function parseBearer(request, secret, now) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(request.headers.authorization || "");
  const userId = match ? verifyAccessToken(match[1], secret, now) : null;
  if (!userId) {
    fail(401, "UNAUTHENTICATED", "A valid access token is required.");
  }
  return userId;
}

function requireExistingUser(database, userId) {
  const user = database.prepare("SELECT user_id FROM users WHERE user_id = ?;").get(userId);
  if (!user) {
    fail(401, "UNAUTHENTICATED", "The authenticated user no longer exists.");
  }
}

function ownedRecord(database, table, id, userId) {
  const row = database.prepare(`SELECT * FROM ${table} WHERE id = ?;`).get(id);
  if (!row) {
    fail(404, "NOT_FOUND", "The requested resource was not found.");
  }
  if (row.owner_id !== userId) {
    fail(403, "FORBIDDEN", "The resource belongs to another user.");
  }
  return row;
}

function checkIfMatch(request, row) {
  const value = request.headers["if-match"];
  if (value === undefined) {
    fail(428, "PRECONDITION_REQUIRED", "The If-Match header is required.");
  }
  const match = /^"(\d+)"$/.exec(value);
  if (!match) {
    fail(400, "BAD_REQUEST", 'If-Match must be a quoted version, such as "1".');
  }
  if (Number(match[1]) !== row.version) {
    fail(412, "PRECONDITION_FAILED", "The resource has changed since it was read.");
  }
}

function parsePagination(url) {
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? 50 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    fail(400, "BAD_REQUEST", "limit must be an integer between 1 and 100.");
  }
  const cursor = url.searchParams.get("cursor");
  let offset = 0;
  if (cursor !== null) {
    if (cursor.length === 0) {
      fail(400, "BAD_REQUEST", "cursor must not be empty.");
    }
    const match = /^([A-Za-z0-9_-]+)$/.exec(cursor);
    let decoded;
    try {
      decoded = match && Buffer.from(cursor, "base64url").toString("utf8");
    } catch {
      decoded = null;
    }
    const offsetMatch = typeof decoded === "string" && /^page:(\d+)$/.exec(decoded);
    if (!offsetMatch || encodeBase64Url(decoded) !== cursor) {
      fail(400, "BAD_REQUEST", "The collection cursor is invalid.");
    }
    offset = Number(offsetMatch[1]);
    if (!Number.isSafeInteger(offset)) {
      fail(400, "BAD_REQUEST", "The collection cursor is invalid.");
    }
  }
  return { limit, offset };
}

function makePage(items, limit, offset) {
  const hasNext = items.length > limit;
  return {
    items: hasNext ? items.slice(0, limit) : items,
    nextCursor: hasNext ? encodeBase64Url(`page:${offset + limit}`) : null,
  };
}

function transaction(database, action) {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = action();
    database.exec("COMMIT;");
    return result;
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

function resourceCreate(database, request, response, url, userId, kind, parentBookId, now) {
  return readJson(request).then((body) => {
    validateResourceBody(kind, body, false);
    if (parentBookId) {
      ownedRecord(database, "books", parentBookId, userId);
    }
    const id = randomUUID();
    const timestamp = now().toISOString();
    const definition = RESOURCE_DEFINITIONS[kind];
    if (kind === "entries") {
      const { title, displayTitle } = deriveDisplayTitle(body.content, body.title);
      database.prepare(
        `INSERT INTO ${definition.table}
          (id, owner_id, version, content, title, display_title, entry_type, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?);`,
      ).run(
        id,
        userId,
        body.content,
        title,
        displayTitle,
        body.entryType || "General Note",
        timestamp,
        timestamp,
      );
    } else {
      const value = kind === "tags" ? body.name : body.title;
      if (kind === "chapters") {
        database.prepare(
          `INSERT INTO ${definition.table}
            (id, owner_id, book_id, version, title, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?, ?);`,
        ).run(id, userId, parentBookId, value, timestamp, timestamp);
      } else {
        const column = kind === "tags" ? "name" : "title";
        database.prepare(
          `INSERT INTO ${definition.table}
            (id, owner_id, version, ${column}, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?);`,
        ).run(id, userId, value, timestamp, timestamp);
      }
    }
    const created = database.prepare(`SELECT * FROM ${definition.table} WHERE id = ?;`).get(id);
    sendJson(response, 201, definition.toJson(created), {
      ETag: '"1"',
      Location: `${url.pathname.replace(/\/+$/, "")}/${id}`,
    });
  });
}

function resourceList(database, response, url, userId, kind, parentBookId) {
  if (parentBookId) {
    ownedRecord(database, "books", parentBookId, userId);
  }
  const { limit, offset } = parsePagination(url);
  const definition = RESOURCE_DEFINITIONS[kind];
  const where = parentBookId ? "owner_id = ? AND book_id = ?" : "owner_id = ?";
  const parameters = parentBookId
    ? [userId, parentBookId, limit + 1, offset]
    : [userId, limit + 1, offset];
  const rows = database.prepare(
    `SELECT * FROM ${definition.table} WHERE ${where}
     ORDER BY created_at, id LIMIT ? OFFSET ?;`,
  ).all(...parameters);
  const page = makePage(rows.map(definition.toJson), limit, offset);
  sendJson(response, 200, page);
}

function resourceDetail(database, request, response, url, userId, kind, id, parentBookId, now) {
  const definition = RESOURCE_DEFINITIONS[kind];
  const row = ownedRecord(database, definition.table, id, userId);
  if (parentBookId && row.book_id !== parentBookId) {
    fail(404, "NOT_FOUND", "The requested Chapter was not found in this Book.");
  }
  if (request.method === "GET") {
    sendJson(response, 200, definition.toJson(row), { ETag: `"${row.version}"` });
    return;
  }
  checkIfMatch(request, row);
  if (request.method === "DELETE") {
    database.prepare(`DELETE FROM ${definition.table} WHERE id = ? AND owner_id = ?;`)
      .run(id, userId);
    response.writeHead(204);
    response.end();
    return;
  }
  return readJson(request).then((body) => {
    validateResourceBody(kind, body, request.method === "PATCH");
    const updated = transaction(database, () => {
      const current = ownedRecord(database, definition.table, id, userId);
      checkIfMatch(request, current);
      if (kind === "entries") {
        const currentFields = {
          content: current.content,
          title: current.title,
          entryType: current.entry_type,
        };
        const next = request.method === "PUT"
          ? {
              content: body.content,
              title: body.title,
              entryType: body.entryType || "General Note",
            }
          : { ...currentFields, ...body };
        const { title, displayTitle } = deriveDisplayTitle(next.content, next.title);
        database.prepare(
          `UPDATE entries SET version = version + 1, content = ?, title = ?,
            display_title = ?, entry_type = ?, updated_at = ?
           WHERE id = ? AND owner_id = ?;`,
        ).run(
          next.content,
          title,
          displayTitle,
          next.entryType || "General Note",
          now().toISOString(),
          id,
          userId,
        );
      } else {
        const field = kind === "tags" ? "name" : "title";
        const value = body[field];
        database.prepare(
          `UPDATE ${definition.table} SET version = version + 1, ${field} = ?, updated_at = ?
           WHERE id = ? AND owner_id = ?;`,
        ).run(value, now().toISOString(), id, userId);
      }
      return database.prepare(`SELECT * FROM ${definition.table} WHERE id = ?;`).get(id);
    });
    sendJson(response, 200, definition.toJson(updated), { ETag: `"${updated.version}"` });
  });
}

function selectRelated(database, table, id, userId) {
  return ownedRecord(database, table, id, userId);
}

function validateAssociationBody(body, definition) {
  validateObject(body, definition.fields, definition.fields, definition.fields);
  for (const field of definition.fields) {
    if (body[field].trim().length === 0) {
      fail(422, "VALIDATION_ERROR", `${field} must not be blank.`);
    }
  }
}

function associationOwner(database, table, id, userId) {
  const row = database.prepare(`SELECT * FROM ${table} WHERE id = ?;`).get(id);
  if (!row) {
    fail(404, "NOT_FOUND", "The requested association was not found.");
  }
  if (row.owner_id !== userId) {
    fail(403, "FORBIDDEN", "The association belongs to another user.");
  }
  return row;
}

function associationList(database, response, url, userId, definition) {
  for (const filter of definition.filters) {
    if (url.searchParams.has(filter) && url.searchParams.get(filter).length === 0) {
      fail(400, "BAD_REQUEST", `${filter} must not be empty.`);
    }
  }
  const { limit, offset } = parsePagination(url);
  const clauses = ["owner_id = ?"];
  const parameters = [userId];
  for (const filter of definition.filters) {
    if (url.searchParams.has(filter)) {
      const column = filter.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      clauses.push(`${column} = ?`);
      parameters.push(url.searchParams.get(filter));
    }
  }
  const rows = database.prepare(
    `SELECT * FROM ${definition.table} WHERE ${clauses.join(" AND ")}
     ORDER BY id LIMIT ? OFFSET ?;`,
  ).all(...parameters, limit + 1, offset);
  const page = makePage(rows.map(definition.toJson), limit, offset);
  sendJson(response, 200, page);
}

async function associationCreate(database, request, response, url, userId, routeName, definition) {
  const body = await readJson(request);
  validateAssociationBody(body, definition);
  const created = transaction(database, () => {
    selectRelated(database, "entries", body.entryId, userId);
    let bookId;
    if (routeName === "entry-tag-associations") {
      selectRelated(database, "tags", body.tagId, userId);
    } else if (routeName === "entry-book-associations") {
      selectRelated(database, "books", body.bookId, userId);
      bookId = body.bookId;
    } else {
      const chapter = selectRelated(database, "chapters", body.chapterId, userId);
      bookId = chapter.book_id;
    }
    const values = routeName === "entry-tag-associations"
      ? [body.entryId, body.tagId]
      : routeName === "entry-book-associations"
        ? [body.entryId, body.bookId]
        : [body.entryId, body.chapterId];
    const existing = database.prepare(
      `SELECT id FROM ${definition.table} WHERE owner_id = ? AND ${definition.columns[0]} = ?
       AND ${definition.columns[1]} = ?;`,
    ).get(userId, ...values);
    if (existing) {
      fail(409, "DUPLICATE_RELATIONSHIP", "This relationship already exists.");
    }
    const id = randomUUID();
    if (routeName === "entry-chapter-associations") {
      database.prepare(
        `INSERT INTO ${definition.table}
          (id, owner_id, entry_id, chapter_id, book_id) VALUES (?, ?, ?, ?, ?);`,
      ).run(id, userId, body.entryId, body.chapterId, bookId);
    } else {
      database.prepare(
        `INSERT INTO ${definition.table}
          (id, owner_id, ${definition.columns.join(", ")}) VALUES (?, ?, ?, ?);`,
      ).run(id, userId, ...values);
    }
    return {
      id,
      row: database.prepare(`SELECT * FROM ${definition.table} WHERE id = ?;`).get(id),
    };
  });
  sendJson(response, 201, definition.toJson(created.row), {
    Location: `${url.pathname.replace(/\/+$/, "")}/${created.id}`,
  });
}

function associationDelete(database, response, definition, id, userId) {
  associationOwner(database, definition.table, id, userId);
  database.prepare(`DELETE FROM ${definition.table} WHERE id = ? AND owner_id = ?;`)
    .run(id, userId);
  response.writeHead(204);
  response.end();
}

function entryLinkJson(row) {
  return { id: row.id, entryIds: [row.entry_a_id, row.entry_b_id] };
}

function entryLinkList(database, response, url, userId) {
  const entryId = url.searchParams.get("entryId");
  if (entryId !== null && entryId.length === 0) {
    fail(400, "BAD_REQUEST", "entryId must not be empty.");
  }
  const { limit, offset } = parsePagination(url);
  const where = entryId === null
    ? "owner_id = ?"
    : "owner_id = ? AND (entry_a_id = ? OR entry_b_id = ?)";
  const parameters = entryId === null
    ? [userId, limit + 1, offset]
    : [userId, entryId, entryId, limit + 1, offset];
  const rows = database.prepare(
    `SELECT * FROM entry_links WHERE ${where} ORDER BY id LIMIT ? OFFSET ?;`,
  ).all(...parameters);
  sendJson(response, 200, makePage(rows.map(entryLinkJson), limit, offset));
}

function entryLinkCreate(database, request, response, url, userId) {
  return readJson(request).then((body) => {
    validateObject(body, ["entryIdA", "entryIdB"], ["entryIdA", "entryIdB"], ["entryIdA", "entryIdB"]);
    if (body.entryIdA.trim().length === 0 || body.entryIdB.trim().length === 0) {
      fail(422, "VALIDATION_ERROR", "Entry identifiers must not be blank.");
    }
    if (body.entryIdA === body.entryIdB) {
      fail(422, "VALIDATION_ERROR", "An Entry Link must connect two different Entries.");
    }
    const [entryAId, entryBId] = [body.entryIdA, body.entryIdB].sort();
    const link = transaction(database, () => {
      selectRelated(database, "entries", entryAId, userId);
      selectRelated(database, "entries", entryBId, userId);
      const duplicate = database.prepare(
        "SELECT id FROM entry_links WHERE owner_id = ? AND entry_a_id = ? AND entry_b_id = ?;",
      ).get(userId, entryAId, entryBId);
      if (duplicate) {
        fail(409, "DUPLICATE_RELATIONSHIP", "This Entry Link already exists.");
      }
      const id = randomUUID();
      database.prepare(
        "INSERT INTO entry_links (id, owner_id, entry_a_id, entry_b_id) VALUES (?, ?, ?, ?);",
      ).run(id, userId, entryAId, entryBId);
      return id;
    });
    sendJson(response, 201, { id: link, entryIds: [entryAId, entryBId] }, {
      Location: `${url.pathname.replace(/\/+$/, "")}/${link}`,
    });
  });
}

function entryLinkDelete(database, response, id, userId) {
  associationDelete(database, response, { table: "entry_links" }, id, userId);
}

function syncTable(resourceType) {
  const resourceTables = {
    entry: "entries",
    book: "books",
    chapter: "chapters",
    tag: "tags",
    entryTagAssociation: "entry_tag_associations",
    entryBookAssociation: "entry_book_associations",
    entryChapterAssociation: "entry_chapter_associations",
    entryLink: "entry_links",
  };
  const table = resourceTables[resourceType];
  if (!table) {
    fail(422, "VALIDATION_ERROR", `Unsupported synchronization resource type ${resourceType}.`);
  }
  return table;
}

function syncResourceJson(database, resourceType, resourceId) {
  const table = syncTable(resourceType);
  const row = database.prepare(`SELECT * FROM ${table} WHERE id = ?;`).get(resourceId);
  if (!row) {
    return null;
  }
  const kindByResourceType = {
    entry: "entries",
    book: "books",
    chapter: "chapters",
    tag: "tags",
  };
  if (kindByResourceType[resourceType]) {
    return RESOURCE_DEFINITIONS[kindByResourceType[resourceType]].toJson(row);
  }
  if (resourceType === "entryTagAssociation") {
    return ASSOCIATION_DEFINITIONS["entry-tag-associations"].toJson(row);
  }
  if (resourceType === "entryBookAssociation") {
    return ASSOCIATION_DEFINITIONS["entry-book-associations"].toJson(row);
  }
  if (resourceType === "entryChapterAssociation") {
    return ASSOCIATION_DEFINITIONS["entry-chapter-associations"].toJson(row);
  }
  return entryLinkJson(row);
}

function writeSyncJournal(database, userId, resourceType, resourceId, operation, version) {
  const resource = operation === "delete"
    ? null
    : syncResourceJson(database, resourceType, resourceId);
  database.prepare(
    `INSERT INTO sync_changes
      (owner_id, resource_type, resource_id, operation, version, resource_json)
     VALUES (?, ?, ?, ?, ?, ?);`,
  ).run(
    userId,
    resourceType,
    resourceId,
    operation,
    version,
    resource === null ? null : JSON.stringify(resource),
  );
}

function saveClientResourceId(database, userId, resourceType, clientId, resourceId) {
  if (typeof clientId !== "string" || clientId.trim().length === 0) {
    fail(422, "VALIDATION_ERROR", "Each create change requires a nonblank clientResourceId.");
  }
  const existing = database.prepare(
    `SELECT resource_id FROM sync_client_ids
     WHERE owner_id = ? AND resource_type = ? AND client_id = ?;`,
  ).get(userId, resourceType, clientId);
  if (existing && existing.resource_id !== resourceId) {
    fail(409, "IDEMPOTENCY_KEY_CONFLICT", "The client resource ID is already mapped to another resource.");
  }
  database.prepare(
    `INSERT OR IGNORE INTO sync_client_ids (owner_id, resource_type, client_id, resource_id)
     VALUES (?, ?, ?, ?);`,
  ).run(userId, resourceType, clientId, resourceId);
}

function resolveSyncReference(database, resourceType, clientId, userId) {
  if (typeof clientId !== "string" || clientId.trim().length === 0) {
    fail(422, "VALIDATION_ERROR", "Synchronization resource references must be nonblank strings.");
  }
  const mapped = database.prepare(
    `SELECT resource_id FROM sync_client_ids
     WHERE owner_id = ? AND resource_type = ? AND client_id = ?;`,
  ).get(userId, resourceType, clientId);
  if (mapped) {
    return mapped.resource_id;
  }
  const table = syncTable(resourceType);
  ownedRecord(database, table, clientId, userId);
  return clientId;
}

function syncCreate(database, userId, change, now) {
  const { resourceType, resource, clientResourceId } = change;
  if (!SYNC_RESOURCE_TYPES.has(resourceType)) {
    fail(422, "VALIDATION_ERROR", `Unsupported synchronization resource type ${resourceType}.`);
  }
  const remoteId = randomUUID();
  const timestamp = now().toISOString();
  if (resourceType === "entry") {
    validateResourceBody("entries", resource, false);
    const { title, displayTitle } = deriveDisplayTitle(resource.content, resource.title);
    database.prepare(
      `INSERT INTO entries
        (id, owner_id, version, content, title, display_title, entry_type, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?);`,
    ).run(
      remoteId,
      userId,
      resource.content,
      title,
      displayTitle,
      resource.entryType || "General Note",
      timestamp,
      timestamp,
    );
  } else if (resourceType === "book" || resourceType === "tag") {
    const kind = resourceType === "book" ? "books" : "tags";
    validateResourceBody(kind, resource, false);
    const field = resourceType === "book" ? "title" : "name";
    database.prepare(
      `INSERT INTO ${kind} (id, owner_id, version, ${field}, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?);`,
    ).run(remoteId, userId, resource[field], timestamp, timestamp);
  } else if (resourceType === "chapter") {
    validateResourceBody("chapters", { title: resource.title }, false);
    const bookId = resolveSyncReference(database, "book", resource.bookId, userId);
    database.prepare(
      `INSERT INTO chapters
        (id, owner_id, book_id, version, title, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?);`,
    ).run(remoteId, userId, bookId, resource.title, timestamp, timestamp);
  } else {
    createSyncAssociation(database, userId, resourceType, resource, remoteId);
  }

  saveClientResourceId(database, userId, resourceType, clientResourceId, remoteId);
  writeSyncJournal(database, userId, resourceType, remoteId, "create", 1);
  return { resourceId: remoteId, version: 1 };
}

function createSyncAssociation(database, userId, resourceType, resource, id) {
  if (resourceType === "entryTagAssociation") {
    const definition = ASSOCIATION_DEFINITIONS["entry-tag-associations"];
    validateAssociationBody(resource, definition);
    const entryId = resolveSyncReference(database, "entry", resource.entryId, userId);
    const tagId = resolveSyncReference(database, "tag", resource.tagId, userId);
    if (database.prepare(
      "SELECT id FROM entry_tag_associations WHERE owner_id = ? AND entry_id = ? AND tag_id = ?;",
    ).get(userId, entryId, tagId)) {
      fail(409, "DUPLICATE_RELATIONSHIP", "This relationship already exists.");
    }
    database.prepare(
      `INSERT INTO entry_tag_associations (id, owner_id, entry_id, tag_id)
       VALUES (?, ?, ?, ?);`,
    ).run(id, userId, entryId, tagId);
    return;
  }
  if (resourceType === "entryBookAssociation") {
    const definition = ASSOCIATION_DEFINITIONS["entry-book-associations"];
    validateAssociationBody(resource, definition);
    const entryId = resolveSyncReference(database, "entry", resource.entryId, userId);
    const bookId = resolveSyncReference(database, "book", resource.bookId, userId);
    if (database.prepare(
      "SELECT id FROM entry_book_associations WHERE owner_id = ? AND entry_id = ? AND book_id = ?;",
    ).get(userId, entryId, bookId)) {
      fail(409, "DUPLICATE_RELATIONSHIP", "This relationship already exists.");
    }
    database.prepare(
      `INSERT INTO entry_book_associations (id, owner_id, entry_id, book_id)
       VALUES (?, ?, ?, ?);`,
    ).run(id, userId, entryId, bookId);
    return;
  }
  if (resourceType === "entryChapterAssociation") {
    const definition = ASSOCIATION_DEFINITIONS["entry-chapter-associations"];
    validateAssociationBody(resource, definition);
    const entryId = resolveSyncReference(database, "entry", resource.entryId, userId);
    const chapterId = resolveSyncReference(database, "chapter", resource.chapterId, userId);
    const chapter = ownedRecord(database, "chapters", chapterId, userId);
    if (database.prepare(
      "SELECT id FROM entry_chapter_associations WHERE owner_id = ? AND entry_id = ? AND chapter_id = ?;",
    ).get(userId, entryId, chapterId)) {
      fail(409, "DUPLICATE_RELATIONSHIP", "This relationship already exists.");
    }
    database.prepare(
      `INSERT INTO entry_chapter_associations
        (id, owner_id, entry_id, chapter_id, book_id) VALUES (?, ?, ?, ?, ?);`,
    ).run(id, userId, entryId, chapterId, chapter.book_id);
    return;
  }
  if (resourceType === "entryLink") {
    validateObject(resource, ["entryIdA", "entryIdB"], ["entryIdA", "entryIdB"], ["entryIdA", "entryIdB"]);
    const first = resolveSyncReference(database, "entry", resource.entryIdA, userId);
    const second = resolveSyncReference(database, "entry", resource.entryIdB, userId);
    if (first === second) {
      fail(422, "VALIDATION_ERROR", "An Entry Link must connect two different Entries.");
    }
    const [entryAId, entryBId] = [first, second].sort();
    if (database.prepare(
      "SELECT id FROM entry_links WHERE owner_id = ? AND entry_a_id = ? AND entry_b_id = ?;",
    ).get(userId, entryAId, entryBId)) {
      fail(409, "DUPLICATE_RELATIONSHIP", "This Entry Link already exists.");
    }
    database.prepare(
      "INSERT INTO entry_links (id, owner_id, entry_a_id, entry_b_id) VALUES (?, ?, ?, ?);",
    ).run(id, userId, entryAId, entryBId);
    return;
  }
  fail(422, "VALIDATION_ERROR", `Unsupported synchronization resource type ${resourceType}.`);
}

function syncUpdate(database, userId, change, now) {
  if (!SYNC_RESOURCE_TYPES.has(change.resourceType)) {
    fail(422, "VALIDATION_ERROR", `Unsupported synchronization resource type ${change.resourceType}.`);
  }
  if (
    change.resourceType.endsWith("Association") ||
    change.resourceType === "entryLink"
  ) {
    fail(422, "VALIDATION_ERROR", "Relationship resources do not support update operations.");
  }
  const table = syncTable(change.resourceType);
  const row = ownedRecord(database, table, change.resourceId, userId);
  if (row.version !== change.baseVersion) {
    const definition = RESOURCE_DEFINITIONS[
      change.resourceType === "entry" ? "entries" :
        change.resourceType === "book" ? "books" :
          change.resourceType === "chapter" ? "chapters" : "tags"
    ];
    fail(
      409,
      "VERSION_CONFLICT",
      "The resource has changed since the supplied version.",
      undefined,
      {
        conflict: {
          changeId: change.changeId,
          localVersion: { ...change.resource, version: change.baseVersion },
          serverVersion: definition.toJson(row),
        },
      },
    );
  }

  const kind = change.resourceType === "entry" ? "entries" :
    change.resourceType === "book" ? "books" :
      change.resourceType === "chapter" ? "chapters" : "tags";
  validateResourceBody(kind, change.resource, false);
  const timestamp = now().toISOString();
  if (change.resourceType === "entry") {
    const { title, displayTitle } = deriveDisplayTitle(change.resource.content, change.resource.title);
    database.prepare(
      `UPDATE entries SET version = version + 1, content = ?, title = ?, display_title = ?,
        entry_type = ?, updated_at = ? WHERE id = ? AND owner_id = ?;`,
    ).run(
      change.resource.content,
      title,
      displayTitle,
      change.resource.entryType || "General Note",
      timestamp,
      row.id,
      userId,
    );
  } else {
    const column = change.resourceType === "tag" ? "name" : "title";
    const value = change.resource[column];
    database.prepare(
      `UPDATE ${table} SET version = version + 1, ${column} = ?, updated_at = ?
       WHERE id = ? AND owner_id = ?;`,
    ).run(value, timestamp, row.id, userId);
  }
  const updated = database.prepare(`SELECT * FROM ${table} WHERE id = ?;`).get(row.id);
  const version = updated.version;
  writeSyncJournal(database, userId, change.resourceType, row.id, "update", version);
  return { resourceId: row.id, version };
}

function syncDelete(database, userId, change) {
  if (!SYNC_RESOURCE_TYPES.has(change.resourceType)) {
    fail(422, "VALIDATION_ERROR", `Unsupported synchronization resource type ${change.resourceType}.`);
  }
  const table = syncTable(change.resourceType);
  const row = ownedRecord(database, table, change.resourceId, userId);
  if (change.resourceType.endsWith("Association") || change.resourceType === "entryLink") {
    database.prepare(`DELETE FROM ${table} WHERE id = ? AND owner_id = ?;`)
      .run(row.id, userId);
    writeSyncJournal(database, userId, change.resourceType, row.id, "delete", 1);
    database.prepare(
      `DELETE FROM sync_client_ids
       WHERE owner_id = ? AND resource_type = ? AND resource_id = ?;`,
    ).run(userId, change.resourceType, row.id);
    return { resourceId: row.id, version: 1 };
  }
  if (row.version !== change.baseVersion) {
    const definition = RESOURCE_DEFINITIONS[
      change.resourceType === "entry" ? "entries" :
        change.resourceType === "book" ? "books" :
          change.resourceType === "chapter" ? "chapters" : "tags"
    ];
    fail(
      409,
      "VERSION_CONFLICT",
      "The resource has changed since the supplied version.",
      undefined,
      {
        conflict: {
          changeId: change.changeId,
          localVersion: { version: change.baseVersion, deleted: true },
          serverVersion: definition.toJson(row),
        },
      },
    );
  }
  const version = row.version;
  database.prepare(`DELETE FROM ${table} WHERE id = ? AND owner_id = ?;`).run(row.id, userId);
  writeSyncJournal(database, userId, change.resourceType, row.id, "delete", version);
  database.prepare(
    `DELETE FROM sync_client_ids
     WHERE owner_id = ? AND resource_type = ? AND resource_id = ?;`,
  ).run(userId, change.resourceType, row.id);
  return { resourceId: row.id, version };
}

function validateSyncChange(change) {
  if (!change || typeof change !== "object" || Array.isArray(change)) {
    fail(422, "VALIDATION_ERROR", "Each synchronization change must be an object.");
  }
  const allowed = [
    "changeId",
    "resourceType",
    "operation",
    "resource",
    "resourceId",
    "baseVersion",
    "clientResourceId",
  ];
  const unsupported = Object.keys(change).find((key) => !allowed.includes(key));
  if (unsupported) {
    fail(422, "VALIDATION_ERROR", `Unsupported synchronization field ${unsupported}.`);
  }
  if (typeof change.changeId !== "string" || change.changeId.trim().length === 0) {
    fail(422, "VALIDATION_ERROR", "Each change requires a nonblank changeId.");
  }
  if (!SYNC_RESOURCE_TYPES.has(change.resourceType)) {
    fail(422, "VALIDATION_ERROR", "Each change requires a supported resourceType.");
  }
  if (!["create", "update", "delete"].includes(change.operation)) {
    fail(422, "VALIDATION_ERROR", "Each change requires a supported operation.");
  }
  if (change.operation === "create") {
    if (
      typeof change.clientResourceId !== "string" ||
      change.clientResourceId.trim().length === 0
    ) {
      fail(422, "VALIDATION_ERROR", "Create changes require clientResourceId.");
    }
    if (!change.resource || typeof change.resource !== "object" || Array.isArray(change.resource)) {
      fail(422, "VALIDATION_ERROR", "Create changes require a resource object.");
    }
  } else {
    if (typeof change.resourceId !== "string" || change.resourceId.trim().length === 0) {
      fail(422, "VALIDATION_ERROR", "Update and delete changes require resourceId.");
    }
    if (!Number.isInteger(change.baseVersion) || change.baseVersion < 1) {
      fail(422, "VALIDATION_ERROR", "Update and delete changes require a positive baseVersion.");
    }
    if (
      change.operation === "update" &&
      (!change.resource || typeof change.resource !== "object" || Array.isArray(change.resource))
    ) {
      fail(422, "VALIDATION_ERROR", "Update changes require a resource object.");
    }
  }
}

function pushSyncChanges(database, request, response, userId, now) {
  return readJson(request).then((body) => {
    validateObject(body, ["changes"], ["changes"]);
    if (!Array.isArray(body.changes)) {
      fail(422, "VALIDATION_ERROR", "changes must be an array.");
    }
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
      fail(400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header is required.");
    }
    if (idempotencyKey.length > 255) {
      fail(400, "BAD_REQUEST", "Idempotency-Key must not exceed 255 characters.");
    }
    const seenChangeIds = new Set();
    for (const change of body.changes) {
      validateSyncChange(change);
      if (seenChangeIds.has(change.changeId)) {
        fail(422, "VALIDATION_ERROR", "changeId values must be unique within a push.");
      }
      seenChangeIds.add(change.changeId);
    }

    const requestHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const existing = database.prepare(
      `SELECT request_hash, response_json FROM sync_idempotency
       WHERE owner_id = ? AND idempotency_key = ?;`,
    ).get(userId, idempotencyKey);
    if (existing) {
      if (existing.request_hash !== requestHash) {
        fail(
          409,
          "IDEMPOTENCY_KEY_CONFLICT",
          "This Idempotency-Key was already used for a different request.",
          undefined,
          { idempotencyKey },
        );
      }
      sendJson(response, 200, JSON.parse(existing.response_json));
      return;
    }

    const priority = (change) => {
      const primary = ["entry", "book", "chapter", "tag"].includes(change.resourceType);
      if (change.operation === "create") {
        return primary ? (change.resourceType === "chapter" ? 1 : 0) : 2;
      }
      if (change.operation === "update") return primary ? 3 : 4;
      return primary ? 6 : 5;
    };
    const orderedChanges = body.changes
      .map((change, index) => ({ change, index }))
      .sort((left, right) => priority(left.change) - priority(right.change) || left.index - right.index);

    const results = transaction(database, () => {
      const changeResults = new Array(body.changes.length);
      for (const { change, index } of orderedChanges) {
        let result;
        if (change.operation === "create") {
          result = syncCreate(database, userId, change, now);
        } else {
          const remoteId = resolveSyncReference(
            database,
            change.resourceType,
            change.resourceId,
            userId,
          );
          const normalized = { ...change, resourceId: remoteId };
          result = change.operation === "update"
            ? syncUpdate(database, userId, normalized, now)
            : syncDelete(database, userId, normalized);
        }
        changeResults[index] = {
          changeId: change.changeId,
          status: "acknowledged",
          resourceId: result.resourceId,
          version: result.version,
        };
      }
      const pushResponse = { results: changeResults };
      database.prepare(
        `INSERT INTO sync_idempotency
          (owner_id, idempotency_key, request_hash, response_json)
         VALUES (?, ?, ?, ?);`,
      ).run(userId, idempotencyKey, requestHash, JSON.stringify(pushResponse));
      return pushResponse;
    });
    sendJson(response, 200, results);
  });
}

function encodeSyncCursor(userId, sequence, secret) {
  const payload = Buffer.from(JSON.stringify({ userId, sequence })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodeSyncCursor(cursor, userId, secret) {
  const parts = cursor.split(".");
  if (parts.length !== 2) {
    fail(400, "BAD_REQUEST", "The synchronization cursor is invalid.");
  }
  const expected = createHmac("sha256", secret).update(parts[0]).digest();
  let actual;
  let payload;
  try {
    actual = Buffer.from(parts[1], "base64url");
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    fail(400, "BAD_REQUEST", "The synchronization cursor is invalid.");
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    fail(400, "BAD_REQUEST", "The synchronization cursor is invalid.");
  }
  if (payload.userId !== userId) {
    fail(403, "FORBIDDEN", "The synchronization cursor belongs to another user.");
  }
  if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 0) {
    fail(400, "BAD_REQUEST", "The synchronization cursor is invalid.");
  }
  return payload.sequence;
}

function pullSyncChanges(database, response, url, userId, secret) {
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && cursor.length === 0) {
    fail(400, "BAD_REQUEST", "cursor must not be empty.");
  }
  const afterSequence = cursor === null ? 0 : decodeSyncCursor(cursor, userId, secret);
  const rows = database.prepare(
    `SELECT sequence, resource_type, resource_id, operation, version, resource_json
     FROM sync_changes WHERE owner_id = ? AND sequence > ? ORDER BY sequence;`,
  ).all(userId, afterSequence);
  const latestSequence = database.prepare(
    "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM sync_changes;",
  ).get().sequence;
  const changes = rows.map((row) => ({
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    operation: row.operation,
    version: row.version,
    ...(row.resource_json === null ? {} : { resource: JSON.parse(row.resource_json) }),
  }));
  sendJson(response, 200, {
    changes,
    nextCursor: encodeSyncCursor(userId, latestSequence, secret),
  });
}

function methodNotAllowed(response, methods) {
  const error = new ApiError(405, "METHOD_NOT_ALLOWED", "The HTTP method is not supported for this resource.");
  response.writeHead(405, {
    Allow: methods.join(", "),
    "Content-Type": "application/problem+json; charset=utf-8",
  });
  response.end(JSON.stringify({
    type: "about:blank",
    title: error.title,
    status: error.status,
    code: error.code,
    detail: error.message,
  }));
}

function register(database, body, now) {
  validateObject(body, ["email", "password"], ["email", "password"], ["email", "password"]);
  const email = body.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || [...body.password].length < 8) {
    fail(422, "VALIDATION_ERROR", "A valid email and a password of at least 8 characters are required.");
  }
  if (database.prepare("SELECT user_id FROM users WHERE email = ?;").get(email)) {
    fail(409, "EMAIL_ALREADY_REGISTERED", "An account with this email address already exists.");
  }
  return { email, userId: randomUUID(), createdAt: now().toISOString() };
}

async function hashPassword(password, salt) {
  const derived = await scryptAsync(password, salt, 64);
  return derived.toString("hex");
}

function handleHealth(request, response) {
  if (request.method !== "GET") {
    methodNotAllowed(response, ["GET"]);
    return;
  }
  sendJson(response, 200, { status: "ok" });
}

async function handleAuthentication(database, request, response, url, options) {
  const { secret, now } = options;
  if (url.pathname === "/api/v1/auth/register") {
    if (request.method !== "POST") {
      methodNotAllowed(response, ["POST"]);
      return;
    }
    const body = await readJson(request);
    const user = register(database, body, now);
    const salt = randomBytes(16).toString("hex");
    const passwordHash = await hashPassword(body.password, salt);
    try {
      database.prepare(
        "INSERT INTO users (user_id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?);",
      ).run(user.userId, user.email, passwordHash, salt, user.createdAt);
    } catch (error) {
      const concurrentlyRegistered = database.prepare(
        "SELECT user_id FROM users WHERE email = ?;",
      ).get(user.email);
      if (concurrentlyRegistered) {
        fail(409, "EMAIL_ALREADY_REGISTERED", "An account with this email address already exists.");
      }
      throw error;
    }
    sendJson(response, 201, {
      user: {
        userId: user.userId,
        email: user.email,
        createdAt: user.createdAt,
      },
    });
    return;
  }
  if (url.pathname === "/api/v1/auth/login") {
    if (request.method !== "POST") {
      methodNotAllowed(response, ["POST"]);
      return;
    }
    const body = await readJson(request);
    validateObject(body, ["email", "password"], ["email", "password"], ["email", "password"]);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) || [...body.password].length < 8) {
      fail(422, "VALIDATION_ERROR", "A valid email and a password of at least 8 characters are required.");
    }
    const user = database.prepare("SELECT * FROM users WHERE email = ?;").get(body.email.trim());
    const passwordHash = user ? await hashPassword(body.password, user.password_salt) : null;
    const passwordMatches = user && timingSafeEqual(
      Buffer.from(passwordHash, "hex"),
      Buffer.from(user.password_hash, "hex"),
    );
    if (!passwordMatches) {
      fail(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    }
    sendJson(response, 200, makeTokenResponse(database, user, secret, now));
    return;
  }
  if (url.pathname === "/api/v1/auth/refresh") {
    if (request.method !== "POST") {
      methodNotAllowed(response, ["POST"]);
      return;
    }
    const body = await readJson(request);
    validateObject(body, ["refreshToken"], ["refreshToken"], ["refreshToken"]);
    if (body.refreshToken.trim().length === 0) {
      fail(422, "VALIDATION_ERROR", "refreshToken must not be blank.");
    }
    const tokenHash = hashToken(body.refreshToken);
    const oldToken = database.prepare(
      "SELECT users.*, refresh_tokens.expires_at FROM refresh_tokens JOIN users USING (user_id) WHERE token_hash = ?;",
    ).get(tokenHash);
    if (!oldToken || oldToken.expires_at <= now().getTime()) {
      if (oldToken) {
        database.prepare("DELETE FROM refresh_tokens WHERE token_hash = ?;").run(tokenHash);
      }
      fail(401, "INVALID_REFRESH_TOKEN", "The refresh token is invalid or expired.");
    }
    const result = transaction(database, () => {
      const currentToken = database.prepare(
        "SELECT users.*, refresh_tokens.expires_at FROM refresh_tokens JOIN users USING (user_id) WHERE token_hash = ?;",
      ).get(tokenHash);
      if (!currentToken || currentToken.expires_at <= now().getTime()) {
        fail(401, "INVALID_REFRESH_TOKEN", "The refresh token is invalid or expired.");
      }
      database.prepare("DELETE FROM refresh_tokens WHERE token_hash = ?;").run(tokenHash);
      return makeTokenResponse(database, currentToken, secret, now);
    });
    sendJson(response, 200, result);
    return;
  }
  if (url.pathname === "/api/v1/auth/me") {
    if (request.method !== "GET") {
      methodNotAllowed(response, ["GET"]);
      return;
    }
    const userId = parseBearer(request, secret, now);
    const user = database.prepare("SELECT * FROM users WHERE user_id = ?;").get(userId);
    if (!user) {
      fail(401, "UNAUTHENTICATED", "The authenticated user no longer exists.");
    }
    sendJson(response, 200, publicUser(user));
  }
}

function resolveRoute(pathname) {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 3 || segments[0] !== "api" || segments[1] !== "v1") {
    return null;
  }
  if (["entries", "books", "tags"].includes(segments[2])) {
    if (segments.length === 3) {
      return { type: "resource-collection", kind: segments[2] };
    }
    if (segments.length === 4) {
      return { type: "resource-detail", kind: segments[2], id: segments[3] };
    }
  }
  if (segments[2] === "books" && segments.length === 5 && segments[4] === "chapters") {
    return { type: "resource-collection", kind: "chapters", bookId: segments[3] };
  }
  if (
    segments[2] === "books" &&
    segments.length === 6 &&
    segments[4] === "chapters"
  ) {
    return {
      type: "resource-detail",
      kind: "chapters",
      bookId: segments[3],
      id: segments[5],
    };
  }
  if (Object.hasOwn(ASSOCIATION_DEFINITIONS, segments[2])) {
    if (segments.length === 3) {
      return { type: "association-collection", name: segments[2] };
    }
    if (segments.length === 4) {
      return { type: "association-detail", name: segments[2], id: segments[3] };
    }
  }
  if (segments[2] === "entry-links") {
    if (segments.length === 3) {
      return { type: "link-collection" };
    }
    if (segments.length === 4) {
      return { type: "link-detail", id: segments[3] };
    }
  }
  return null;
}

function routeMethods(route) {
  if (!route) return [];
  if (route.type === "resource-collection" || route.type === "association-collection" || route.type === "link-collection") {
    return ["GET", "POST"];
  }
  if (route.type === "resource-detail") {
    return ["GET", "PUT", "PATCH", "DELETE"];
  }
  if (route.type === "association-detail" || route.type === "link-detail") {
    return ["DELETE"];
  }
  return [];
}

function createApiServer({
  database,
  secret,
  now = () => new Date(),
  logger = (event) => console.info(JSON.stringify(event)),
  createRequestId = randomUUID,
} = {}) {
  if (!database || typeof database.prepare !== "function" || typeof database.exec !== "function") {
    throw new TypeError("WNT-11 API server requires a SQLite database connection.");
  }
  if (typeof secret !== "string" || secret.length < 32) {
    throw new TypeError("WNT-11 API server requires a signing secret of at least 32 characters.");
  }
  if (typeof now !== "function" || typeof logger !== "function" || typeof createRequestId !== "function") {
    throw new TypeError("WNT-11 API server requires clock, logger, and request ID functions.");
  }

  const options = { secret, now };
  const server = createServer((request, response) => {
    const requestId = createRequestId();
    const startedAt = performance.now();
    let userId;
    response.setHeader("X-Request-Id", requestId);
    response.once("finish", () => {
      try {
        logger({
          event: "http.request.completed",
          requestId,
          method: request.method,
          path: new URL(request.url, "http://localhost").pathname,
          status: response.statusCode,
          userId: userId || null,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        });
      } catch (error) {
        console.error("WNT-11 API request logging failed:", error);
      }
    });

    void (async () => {
      try {
        const url = new URL(request.url, "http://localhost");
        if (url.pathname === "/api/v1/health") {
          handleHealth(request, response);
          return;
        }

        const authPaths = [
          "/api/v1/auth/register",
          "/api/v1/auth/login",
          "/api/v1/auth/refresh",
          "/api/v1/auth/me",
        ];
        if (authPaths.includes(url.pathname)) {
          await handleAuthentication(database, request, response, url, options);
          return;
        }

        userId = parseBearer(request, secret, now);
        requireExistingUser(database, userId);
        if (url.pathname === "/api/v1/sync/push") {
          if (request.method !== "POST") {
            methodNotAllowed(response, ["POST"]);
            return;
          }
          await pushSyncChanges(database, request, response, userId, now);
          return;
        }
        if (url.pathname === "/api/v1/sync/pull") {
          if (request.method !== "GET") {
            methodNotAllowed(response, ["GET"]);
            return;
          }
          pullSyncChanges(database, response, url, userId, secret);
          return;
        }
        const route = resolveRoute(url.pathname);
        if (!route) {
          fail(404, "NOT_FOUND", "No API operation matches this path.");
        }
        if (!routeMethods(route).includes(request.method)) {
          methodNotAllowed(response, routeMethods(route));
          return;
        }

        if (route.type === "resource-collection") {
          if (request.method === "GET") {
            resourceList(database, response, url, userId, route.kind, route.bookId);
          } else {
            await resourceCreate(database, request, response, url, userId, route.kind, route.bookId, now);
          }
          return;
        }
        if (route.type === "resource-detail") {
          if (route.bookId) {
            ownedRecord(database, "books", route.bookId, userId);
          }
          await resourceDetail(
            database,
            request,
            response,
            url,
            userId,
            route.kind,
            route.id,
            route.bookId,
            now,
          );
          return;
        }
        if (route.type === "association-collection") {
          const definition = ASSOCIATION_DEFINITIONS[route.name];
          if (request.method === "GET") {
            associationList(database, response, url, userId, definition);
          } else {
            await associationCreate(database, request, response, url, userId, route.name, definition);
          }
          return;
        }
        if (route.type === "association-detail") {
          associationDelete(
            database,
            response,
            ASSOCIATION_DEFINITIONS[route.name],
            route.id,
            userId,
          );
          return;
        }
        if (route.type === "link-collection") {
          if (request.method === "GET") {
            entryLinkList(database, response, url, userId);
          } else {
            await entryLinkCreate(database, request, response, url, userId);
          }
          return;
        }
        entryLinkDelete(database, response, route.id, userId);
      } catch (error) {
        if (!response.headersSent) {
          if (!(error instanceof ApiError)) {
            console.error("WNT-11 API request failed:", error);
          }
          sendProblem(response, error, requestId);
        } else {
          response.destroy(error);
        }
      }
    })();
  });
  return server;
}

module.exports = {
  createApiServer,
};
