"use strict";

const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startApiServer } = require("../src/wnt11");

const SECRET = "wnt11-integration-test-signing-secret";

let apiServer;
let baseUrl;
let accessToken;
let logEvents;
let clockNow;

async function request(pathname, {
  method = "GET",
  body,
  token = accessToken,
  headers = {},
} = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    response,
    data: text ? JSON.parse(text) : undefined,
  };
}

async function createResource(pathname, body, options = {}) {
  const result = await request(pathname, { method: "POST", body, ...options });
  expect(result.response.status).toBe(201);
  return result;
}

function expectProblem(result, status, code) {
  expect(result.response.status).toBe(status);
  expect(result.response.headers.get("content-type")).toContain("application/problem+json");
  expect(result.data).toMatchObject({ status, code });
  expect(result.response.headers.get("x-request-id")).toBeTruthy();
}

beforeEach(async () => {
  logEvents = [];
  clockNow = new Date();
  apiServer = await startApiServer({
    databasePath: ":memory:",
    secret: SECRET,
    host: "127.0.0.1",
    port: 0,
    logger: (event) => logEvents.push(event),
    now: () => clockNow,
  });
  baseUrl = `http://127.0.0.1:${apiServer.server.address().port}`;

  const email = `writer-${randomUUID()}@example.test`;
  const password = "ContractTestPass123";
  expect((await request("/api/v1/auth/register", {
    method: "POST",
    token: null,
    body: { email, password },
  })).response.status).toBe(201);
  const login = await request("/api/v1/auth/login", {
    method: "POST",
    token: null,
    body: { email, password },
  });
  expect(login.response.status).toBe(200);
  accessToken = login.data.accessToken;
});

afterEach(async () => {
  await apiServer.close();
  apiServer = undefined;
  accessToken = undefined;
  clockNow = undefined;
});

describe("WNT-11 SQLite-backed API implementation", () => {
  test("serves a minimal public API liveness response without credentials", async () => {
    const result = await request("/api/v1/health", { token: null });

    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toContain("application/json");
    expect(result.data).toEqual({ status: "ok" });
    expect(JSON.stringify(result.data)).not.toMatch(/secret|database|credential|user/i);
    expect(result.response.headers.get("x-request-id")).toBeTruthy();
    expect(logEvents).toContainEqual(expect.objectContaining({
      event: "http.request.completed",
      method: "GET",
      path: "/api/v1/health",
      status: 200,
      userId: null,
    }));
  });

  test("rejects unsupported methods on the public health endpoint", async () => {
    const result = await request("/api/v1/health", {
      method: "POST",
      token: null,
    });

    expect(result.response.status).toBe(405);
    expect(result.response.headers.get("allow")).toBe("GET");
    expectProblem(result, 405, "METHOD_NOT_ALLOWED");
    expect(logEvents).toContainEqual(expect.objectContaining({
      event: "http.request.completed",
      method: "POST",
      path: "/api/v1/health",
      status: 405,
      userId: null,
    }));
  });

  test("validates server configuration, creates persistent database folders, and cleans failed starts", async () => {
    await expect(startApiServer({
      databasePath: ":memory:",
      secret: "too-short",
    })).rejects.toThrow("at least 32 characters");
    await expect(startApiServer({
      databasePath: ":memory:",
      secret: SECRET,
      port: 65536,
    })).rejects.toThrow("PORT must be an integer");

    const port = apiServer.server.address().port;
    await expect(startApiServer({
      databasePath: ":memory:",
      secret: SECRET,
      host: "127.0.0.1",
      port,
    })).rejects.toThrow();

    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "wnt11-api-"));
    let persistentServer;
    try {
      const databasePath = path.join(temporaryDirectory, "nested", "api.sqlite");
      persistentServer = await startApiServer({
        databasePath,
        secret: SECRET,
        host: "127.0.0.1",
        port: 0,
        logger: () => {},
      });
      expect(fs.existsSync(databasePath)).toBe(true);
      baseUrl = `http://127.0.0.1:${persistentServer.server.address().port}`;
      const email = `persist-${randomUUID()}@example.test`;
      const password = "PersistentPass123";
      await request("/api/v1/auth/register", {
        method: "POST",
        token: null,
        body: { email, password },
      });
      const login = await request("/api/v1/auth/login", {
        method: "POST",
        token: null,
        body: { email, password },
      });
      const book = await createResource("/api/v1/books", { title: "Persistent Book" }, {
        token: login.data.accessToken,
      });
      await persistentServer.close();
      persistentServer = await startApiServer({
        databasePath,
        secret: SECRET,
        host: "127.0.0.1",
        port: 0,
        logger: () => {},
      });
      baseUrl = `http://127.0.0.1:${persistentServer.server.address().port}`;
      expect((await request(`/api/v1/books/${book.data.id}`, {
        token: login.data.accessToken,
      })).data.title).toBe("Persistent Book");
    } finally {
      if (persistentServer) {
        await persistentServer.close();
      }
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("registers, authenticates, refreshes tokens once, and returns the user profile", async () => {
    const refreshed = await request("/api/v1/auth/refresh", {
      method: "POST",
      token: null,
      body: { refreshToken: "unused" },
    });
    expectProblem(refreshed, 401, "INVALID_REFRESH_TOKEN");

    const email = `refresh-${randomUUID()}@example.test`;
    const password = "RefreshTestPass123";
    const registration = await request("/api/v1/auth/register", {
      method: "POST",
      token: null,
      body: { email, password },
    });
    expect(registration.response.status).toBe(201);
    expect(registration.data.user).toMatchObject({ email });
    expect(registration.data.user.password).toBeUndefined();
    expectProblem(await request("/api/v1/auth/register", {
      method: "POST",
      token: null,
      body: { email: email.toUpperCase(), password },
    }), 409, "EMAIL_ALREADY_REGISTERED");
    expectProblem(await request("/api/v1/auth/register", {
      method: "POST",
      token: null,
      body: { email: "not-an-email", password: "short" },
    }), 422, "VALIDATION_ERROR");
    const concurrentEmail = `concurrent-${randomUUID()}@example.test`;
    const concurrentRegistrations = await Promise.all([
      request("/api/v1/auth/register", {
        method: "POST",
        token: null,
        body: { email: concurrentEmail, password },
      }),
      request("/api/v1/auth/register", {
        method: "POST",
        token: null,
        body: { email: concurrentEmail, password },
      }),
    ]);
    expect(concurrentRegistrations.map((result) => result.response.status).sort())
      .toEqual([201, 409]);
    expectProblem(await request("/api/v1/auth/login", {
      method: "POST",
      token: null,
      body: { email, password: "WrongPass123" },
    }), 401, "INVALID_CREDENTIALS");

    const tokens = await request("/api/v1/auth/login", {
      method: "POST",
      token: null,
      body: { email, password },
    });
    expect(tokens.data).toMatchObject({
      tokenType: "Bearer",
      accessTokenExpiresIn: 900,
    });
    const me = await request("/api/v1/auth/me", { token: tokens.data.accessToken });
    expect(me.response.status).toBe(200);
    expect(me.data).toMatchObject({ userId: registration.data.user.userId, email });
    const rotation = await request("/api/v1/auth/refresh", {
      method: "POST",
      token: null,
      body: { refreshToken: tokens.data.refreshToken },
    });
    expect(rotation.response.status).toBe(200);
    expect(rotation.data.refreshToken).not.toBe(tokens.data.refreshToken);
    expectProblem(await request("/api/v1/auth/refresh", {
      method: "POST",
      token: null,
      body: { refreshToken: tokens.data.refreshToken },
    }), 401, "INVALID_REFRESH_TOKEN");
    const expiringTokens = await request("/api/v1/auth/login", {
      method: "POST",
      token: null,
      body: { email, password },
    });
    clockNow = new Date(clockNow.getTime() + 31 * 24 * 60 * 60 * 1000);
    expectProblem(await request("/api/v1/auth/me", {
      token: expiringTokens.data.accessToken,
    }), 401, "UNAUTHENTICATED");
    expectProblem(await request("/api/v1/auth/refresh", {
      method: "POST",
      token: null,
      body: { refreshToken: expiringTokens.data.refreshToken },
    }), 401, "INVALID_REFRESH_TOKEN");
  });

  test("creates, retrieves, updates, and conditionally deletes versioned Entries", async () => {
    const created = await createResource("/api/v1/entries", {
      content: "A creative note that is longer than twenty-five characters",
    });
    expect(created.response.headers.get("etag")).toBe('"1"');
    expect(created.response.headers.get("location")).toBe(
      `/api/v1/entries/${created.data.id}`,
    );
    expect(created.data).toMatchObject({
      version: 1,
      title: null,
      displayTitle: "A creative note that is l...",
      entryType: "General Note",
    });
    expect(created.data.ownerId).toBeUndefined();

    const detailUrl = `/api/v1/entries/${created.data.id}`;
    const detail = await request(detailUrl);
    expect(detail.response.headers.get("etag")).toBe('"1"');
    expectProblem(await request(detailUrl, {
      method: "PATCH",
      body: { content: "Missing ETag" },
    }), 428, "PRECONDITION_REQUIRED");
    expectProblem(await request(detailUrl, {
      method: "PUT",
      body: { content: "Malformed ETag" },
      headers: { "If-Match": "1" },
    }), 400, "BAD_REQUEST");

    const updated = await request(detailUrl, {
      method: "PATCH",
      body: { content: "Revised content", title: "Revised title", entryType: "Scene" },
      headers: { "If-Match": detail.response.headers.get("etag") },
    });
    expect(updated.response.status).toBe(200);
    expect(updated.response.headers.get("etag")).toBe('"2"');
    expect(updated.data).toMatchObject({
      content: "Revised content",
      title: "Revised title",
      displayTitle: "Revised title",
      entryType: "Scene",
      version: 2,
    });
    expectProblem(await request(detailUrl, {
      method: "PATCH",
      body: { content: "Stale edit" },
      headers: { "If-Match": '"1"' },
    }), 412, "PRECONDITION_FAILED");
    const concurrentEntry = await createResource("/api/v1/entries", {
      content: "Concurrent update target",
    });
    const concurrentUrl = `/api/v1/entries/${concurrentEntry.data.id}`;
    const concurrentUpdates = await Promise.all([
      request(concurrentUrl, {
        method: "PATCH",
        body: { content: "Concurrent update one" },
        headers: { "If-Match": '"1"' },
      }),
      request(concurrentUrl, {
        method: "PATCH",
        body: { content: "Concurrent update two" },
        headers: { "If-Match": '"1"' },
      }),
    ]);
    expect(concurrentUpdates.map((result) => result.response.status).sort())
      .toEqual([200, 412]);

    const replaced = await request(detailUrl, {
      method: "PUT",
      body: { content: "A replacement" },
      headers: { "If-Match": '"2"' },
    });
    expect(replaced.response.status).toBe(200);
    expect(replaced.data).toMatchObject({
      content: "A replacement",
      title: null,
      entryType: "General Note",
      version: 3,
    });
    const deleted = await request(detailUrl, {
      method: "DELETE",
      headers: { "If-Match": '"3"' },
    });
    expect(deleted.response.status).toBe(204);
    expectProblem(await request(detailUrl), 404, "NOT_FOUND");
  });

  test("manages Books and nested Chapters, retaining parent and enforcing scope", async () => {
    const book = await createResource("/api/v1/books", { title: "API Book" });
    const otherBook = await createResource("/api/v1/books", { title: "Other Book" });
    const bookUrl = `/api/v1/books/${book.data.id}`;
    const bookRead = await request(bookUrl);
    const bookPatch = await request(bookUrl, {
      method: "PATCH",
      body: { title: "Patched Book" },
      headers: { "If-Match": bookRead.response.headers.get("etag") },
    });
    expect(bookPatch.data).toMatchObject({ title: "Patched Book", version: 2 });
    const bookReplace = await request(bookUrl, {
      method: "PUT",
      body: { title: "Replaced Book" },
      headers: { "If-Match": bookPatch.response.headers.get("etag") },
    });
    expect(bookReplace.data).toMatchObject({ title: "Replaced Book", version: 3 });
    const chapter = await createResource(`${bookUrl}/chapters`, { title: "Opening" });
    const chapterUrl = `${bookUrl}/chapters/${chapter.data.id}`;
    expect(chapter.data.bookId).toBe(book.data.id);
    expect((await request(chapterUrl)).data.title).toBe("Opening");
    expectProblem(await request(`/api/v1/books/${otherBook.data.id}/chapters/${chapter.data.id}`),
      404,
      "NOT_FOUND");

    const replacement = await request(chapterUrl, {
      method: "PUT",
      body: { title: "Replaced Opening" },
      headers: { "If-Match": '"1"' },
    });
    expect(replacement.data).toMatchObject({ title: "Replaced Opening", version: 2 });
    const patchedChapter = await request(chapterUrl, {
      method: "PATCH",
      body: { title: "Patched Opening" },
      headers: { "If-Match": replacement.response.headers.get("etag") },
    });
    expect(patchedChapter.data).toMatchObject({ title: "Patched Opening", version: 3 });
    expect((await request(chapterUrl, {
      method: "DELETE",
      headers: { "If-Match": patchedChapter.response.headers.get("etag") },
    })).response.status).toBe(204);
    expectProblem(await request(chapterUrl), 404, "NOT_FOUND");
    const deleted = await request(bookUrl, {
      method: "DELETE",
      headers: { "If-Match": bookReplace.response.headers.get("etag") },
    });
    expect(deleted.response.status).toBe(204);
    expectProblem(await request(bookUrl), 404, "NOT_FOUND");
    expect((await request(`/api/v1/books/${otherBook.data.id}`)).response.status).toBe(200);
  });

  test("creates Tags and associations, rejects duplicates, and cleans relationships on delete", async () => {
    const entry = await createResource("/api/v1/entries", { content: "Tagged content" });
    const tag = await createResource("/api/v1/tags", { name: "Draft" });
    const tagUrl = `/api/v1/tags/${tag.data.id}`;
    const tagRead = await request(tagUrl);
    const tagPatch = await request(tagUrl, {
      method: "PATCH",
      body: { name: "Revised Draft" },
      headers: { "If-Match": tagRead.response.headers.get("etag") },
    });
    expect(tagPatch.data).toMatchObject({ name: "Revised Draft", version: 2 });
    const tagReplace = await request(tagUrl, {
      method: "PUT",
      body: { name: "Final Draft" },
      headers: { "If-Match": tagPatch.response.headers.get("etag") },
    });
    expect(tagReplace.data).toMatchObject({ name: "Final Draft", version: 3 });
    const association = await createResource("/api/v1/entry-tag-associations", {
      entryId: entry.data.id,
      tagId: tag.data.id,
    });
    expect(association.data).toMatchObject({ entryId: entry.data.id, tagId: tag.data.id });
    expectProblem(await request("/api/v1/entry-tag-associations", {
      method: "POST",
      body: { entryId: entry.data.id, tagId: tag.data.id },
    }), 409, "DUPLICATE_RELATIONSHIP");
    expectProblem(await request("/api/v1/entry-tag-associations", {
      method: "POST",
      body: { entryId: entry.data.id, tagId: "absent-tag" },
    }), 404, "NOT_FOUND");

    const deletedTag = await request(tagUrl, {
      method: "DELETE",
      headers: { "If-Match": tagReplace.response.headers.get("etag") },
    });
    expect(deletedTag.response.status).toBe(204);
    expect((await request(`/api/v1/entry-tag-associations?entryId=${entry.data.id}`))
      .data.items).toHaveLength(0);
    expect((await request(`/api/v1/entries/${entry.data.id}`)).response.status).toBe(200);
    expectProblem(await request(`/api/v1/entry-tag-associations/${association.data.id}`, {
      method: "DELETE",
    }), 404, "NOT_FOUND");
  });

  test("supports direct and Chapter-derived Book relationships and symmetric Entry Links", async () => {
    const book = await createResource("/api/v1/books", { title: "Related Book" });
    const chapter = await createResource(`/api/v1/books/${book.data.id}/chapters`, {
      title: "Related Chapter",
    });
    const first = await createResource("/api/v1/entries", { content: "First" });
    const second = await createResource("/api/v1/entries", { content: "Second" });
    const direct = await createResource("/api/v1/entry-book-associations", {
      entryId: first.data.id,
      bookId: book.data.id,
    });
    const chapterAssociation = await createResource("/api/v1/entry-chapter-associations", {
      entryId: first.data.id,
      chapterId: chapter.data.id,
    });
    expect(chapterAssociation.data.bookId).toBe(book.data.id);
    expect((await request(`/api/v1/entry-book-associations?entryId=${first.data.id}`))
      .data.items).toEqual([expect.objectContaining({ id: direct.data.id, source: "direct" })]);

    const link = await createResource("/api/v1/entry-links", {
      entryIdA: first.data.id,
      entryIdB: second.data.id,
    });
    expect(link.data.entryIds).toEqual([first.data.id, second.data.id].sort());
    expect((await request(`/api/v1/entry-links?entryId=${second.data.id}`)).data.items)
      .toContainEqual(expect.objectContaining({ id: link.data.id }));
    expectProblem(await request("/api/v1/entry-links", {
      method: "POST",
      body: { entryIdA: second.data.id, entryIdB: first.data.id },
    }), 409, "DUPLICATE_RELATIONSHIP");
    expectProblem(await request("/api/v1/entry-links", {
      method: "POST",
      body: { entryIdA: first.data.id, entryIdB: first.data.id },
    }), 422, "VALIDATION_ERROR");

    expect((await request(`/api/v1/entry-chapter-associations/${chapterAssociation.data.id}`, {
      method: "DELETE",
    })).response.status).toBe(204);
    expect((await request(`/api/v1/entry-book-associations/${direct.data.id}`, {
      method: "DELETE",
    })).response.status).toBe(204);
    expect((await request(`/api/v1/entry-links/${link.data.id}`, {
      method: "DELETE",
    })).response.status).toBe(204);
    expect((await request(`/api/v1/entries/${first.data.id}`)).response.status).toBe(200);
    expect((await request(`/api/v1/entries/${second.data.id}`)).response.status).toBe(200);
  });

  test("cleans all Entry relationships on deletion without deleting related resources", async () => {
    const entry = await createResource("/api/v1/entries", { content: "To be deleted" });
    const retainedEntry = await createResource("/api/v1/entries", { content: "Still available" });
    const book = await createResource("/api/v1/books", { title: "Retained Book" });
    const chapter = await createResource(`/api/v1/books/${book.data.id}/chapters`, {
      title: "Retained Chapter",
    });
    const tag = await createResource("/api/v1/tags", { name: "Retained Tag" });
    await createResource("/api/v1/entry-tag-associations", {
      entryId: entry.data.id,
      tagId: tag.data.id,
    });
    await createResource("/api/v1/entry-book-associations", {
      entryId: entry.data.id,
      bookId: book.data.id,
    });
    await createResource("/api/v1/entry-chapter-associations", {
      entryId: entry.data.id,
      chapterId: chapter.data.id,
    });
    await createResource("/api/v1/entry-links", {
      entryIdA: entry.data.id,
      entryIdB: retainedEntry.data.id,
    });

    expect((await request(`/api/v1/entries/${entry.data.id}`, {
      method: "DELETE",
      headers: { "If-Match": entry.response.headers.get("etag") },
    })).response.status).toBe(204);
    for (const pathname of [
      `/api/v1/entry-tag-associations?entryId=${entry.data.id}`,
      `/api/v1/entry-book-associations?entryId=${entry.data.id}`,
      `/api/v1/entry-chapter-associations?entryId=${entry.data.id}`,
      `/api/v1/entry-links?entryId=${entry.data.id}`,
    ]) {
      expect((await request(pathname)).data.items).toHaveLength(0);
    }
    for (const pathname of [
      `/api/v1/entries/${retainedEntry.data.id}`,
      `/api/v1/books/${book.data.id}`,
      `/api/v1/books/${book.data.id}/chapters/${chapter.data.id}`,
      `/api/v1/tags/${tag.data.id}`,
    ]) {
      expect((await request(pathname)).response.status).toBe(200);
    }
  });

  test("paginates collections, filters associations, and rejects invalid query values", async () => {
    const entries = await Promise.all([
      createResource("/api/v1/entries", { content: "Page one" }),
      createResource("/api/v1/entries", { content: "Page two" }),
      createResource("/api/v1/entries", { content: "Page three" }),
    ]);
    const book = await createResource("/api/v1/books", { title: "Page Book" });
    const chapters = await Promise.all([
      createResource(`/api/v1/books/${book.data.id}/chapters`, { title: "Chapter one" }),
      createResource(`/api/v1/books/${book.data.id}/chapters`, { title: "Chapter two" }),
    ]);
    await createResource("/api/v1/books", { title: "Second Page Book" });
    const tags = await Promise.all([
      createResource("/api/v1/tags", { name: "Page Tag One" }),
      createResource("/api/v1/tags", { name: "Page Tag Two" }),
    ]);
    await createResource("/api/v1/entry-tag-associations", {
      entryId: entries[0].data.id,
      tagId: tags[0].data.id,
    });
    await createResource("/api/v1/entry-tag-associations", {
      entryId: entries[1].data.id,
      tagId: tags[1].data.id,
    });
    await createResource("/api/v1/entry-book-associations", {
      entryId: entries[0].data.id,
      bookId: book.data.id,
    });
    await createResource("/api/v1/entry-book-associations", {
      entryId: entries[1].data.id,
      bookId: book.data.id,
    });
    await createResource("/api/v1/entry-chapter-associations", {
      entryId: entries[0].data.id,
      chapterId: chapters[0].data.id,
    });
    await createResource("/api/v1/entry-chapter-associations", {
      entryId: entries[1].data.id,
      chapterId: chapters[1].data.id,
    });
    await createResource("/api/v1/entry-links", {
      entryIdA: entries[0].data.id,
      entryIdB: entries[1].data.id,
    });
    await createResource("/api/v1/entry-links", {
      entryIdA: entries[1].data.id,
      entryIdB: entries[2].data.id,
    });

    const collections = [
      "/api/v1/entries",
      "/api/v1/books",
      `/api/v1/books/${book.data.id}/chapters`,
      "/api/v1/tags",
      "/api/v1/entry-tag-associations",
      "/api/v1/entry-book-associations",
      "/api/v1/entry-chapter-associations",
      "/api/v1/entry-links",
    ];
    for (const collection of collections) {
      const firstPage = await request(`${collection}?limit=1`);
      expect(firstPage.data.items).toHaveLength(1);
      expect(firstPage.data.nextCursor).toBeTruthy();
      const nextPage = await request(
        `${collection}?limit=1&cursor=${encodeURIComponent(firstPage.data.nextCursor)}`,
      );
      expect(nextPage.data.items).toHaveLength(1);
      expect(nextPage.data.items[0].id).not.toBe(firstPage.data.items[0].id);
    }

    expect((await request(
      `/api/v1/entry-tag-associations?entryId=${entries[0].data.id}&tagId=${tags[0].data.id}`,
    )).data.items).toHaveLength(1);
    expect((await request(
      `/api/v1/entry-book-associations?entryId=${entries[0].data.id}&bookId=${book.data.id}`,
    )).data.items).toHaveLength(1);
    expect((await request(
      `/api/v1/entry-chapter-associations?entryId=${entries[0].data.id}&bookId=${book.data.id}&chapterId=${chapters[0].data.id}`,
    )).data.items).toHaveLength(1);
    for (const query of ["limit=0", "limit=101", "limit=1.5"]) {
      expectProblem(await request(`/api/v1/entries?${query}`), 400, "BAD_REQUEST");
    }
    expectProblem(await request("/api/v1/entries?cursor=unknown"), 400, "BAD_REQUEST");
    expectProblem(await request("/api/v1/entry-tag-associations?tagId="), 400, "BAD_REQUEST");
    expectProblem(await request("/api/v1/entry-chapter-associations?bookId="), 400, "BAD_REQUEST");
    expectProblem(await request("/api/v1/entry-links?entryId="), 400, "BAD_REQUEST");
  });

  test("pushes changes idempotently and pulls user-scoped resources, updates, and tombstones", async () => {
    const changes = [
      {
        changeId: "local-entry",
        resourceType: "entry",
        operation: "create",
        clientResourceId: "entry-local",
        resource: { content: "Synced entry", entryType: "General Note" },
      },
      {
        changeId: "local-book",
        resourceType: "book",
        operation: "create",
        clientResourceId: "book-local",
        resource: { title: "Synced book" },
      },
      {
        changeId: "local-chapter",
        resourceType: "chapter",
        operation: "create",
        clientResourceId: "chapter-local",
        resource: { title: "Synced chapter", bookId: "book-local" },
      },
      {
        changeId: "local-association",
        resourceType: "entryChapterAssociation",
        operation: "create",
        clientResourceId: "chapter-association-local",
        resource: { entryId: "entry-local", chapterId: "chapter-local" },
      },
    ];
    const push = () => request("/api/v1/sync/push", {
      method: "POST",
      body: { changes },
      headers: { "Idempotency-Key": "push-batch-1" },
    });
    const firstPush = await push();
    expect(firstPush.response.status).toBe(200);
    expect(firstPush.data.results).toHaveLength(4);
    const repeatedPush = await push();
    expect(repeatedPush.data).toEqual(firstPush.data);
    expect((await request("/api/v1/entries")).data.items).toHaveLength(1);
    const remoteIds = Object.fromEntries(
      firstPush.data.results.map((result) => [result.changeId, result.resourceId]),
    );

    const initialPull = await request("/api/v1/sync/pull");
    expect(initialPull.response.status).toBe(200);
    expect(initialPull.data.changes).toHaveLength(4);
    const chapterAssociation = initialPull.data.changes.find(
      (change) => change.resourceType === "entryChapterAssociation",
    );
    expect(chapterAssociation.resource).toMatchObject({
      entryId: remoteIds["local-entry"],
      chapterId: remoteIds["local-chapter"],
      bookId: remoteIds["local-book"],
    });

    const updated = await request("/api/v1/sync/push", {
      method: "POST",
      headers: { "Idempotency-Key": "push-update-2" },
      body: {
        changes: [{
          changeId: "update-entry",
          resourceType: "entry",
          operation: "update",
          resourceId: remoteIds["local-entry"],
          baseVersion: 1,
          resource: { content: "Updated synced entry", entryType: "Scene" },
        }],
      },
    });
    expect(updated.response.status).toBe(200);
    expect(updated.data.results[0].version).toBe(2);

    const conflict = await request("/api/v1/sync/push", {
      method: "POST",
      headers: { "Idempotency-Key": "push-stale-3" },
      body: {
        changes: [{
          changeId: "stale-entry",
          resourceType: "entry",
          operation: "update",
          resourceId: remoteIds["local-entry"],
          baseVersion: 1,
          resource: { content: "Stale edit", entryType: "Scene" },
        }],
      },
    });
    expectProblem(conflict, 409, "VERSION_CONFLICT");
    expect(conflict.data.conflict).toMatchObject({
      changeId: "stale-entry",
      localVersion: { content: "Stale edit", version: 1 },
      serverVersion: { content: "Updated synced entry", version: 2 },
    });

    const foreignUser = await request("/api/v1/auth/register", {
      method: "POST",
      token: null,
      body: {
        email: `cursor-${randomUUID()}@example.test`,
        password: "CursorTestPass123",
      },
    });
    expect(foreignUser.response.status).toBe(201);
    const foreignLogin = await request("/api/v1/auth/login", {
      method: "POST",
      token: null,
      body: {
        email: foreignUser.data.user.email,
        password: "CursorTestPass123",
      },
    });
    expectProblem(await request(
      `/api/v1/sync/pull?cursor=${encodeURIComponent(initialPull.data.nextCursor)}`,
      { token: foreignLogin.data.accessToken },
    ), 403, "FORBIDDEN");
    expectProblem(await request("/api/v1/sync/push", {
      method: "POST",
      headers: { "Idempotency-Key": "push-batch-1" },
      body: { changes: [{ ...changes[0], resource: { content: "Different payload" } }] },
    }), 409, "IDEMPOTENCY_KEY_CONFLICT");

    const deleteEntry = await request("/api/v1/sync/push", {
      method: "POST",
      headers: { "Idempotency-Key": "push-delete-4" },
      body: {
        changes: [{
          changeId: "delete-entry",
          resourceType: "entry",
          operation: "delete",
          resourceId: remoteIds["local-entry"],
          baseVersion: 2,
        }],
      },
    });
    expect(deleteEntry.response.status).toBe(200);
    const delta = await request(
      `/api/v1/sync/pull?cursor=${encodeURIComponent(initialPull.data.nextCursor)}`,
    );
    expect(delta.data.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceId: remoteIds["local-entry"],
        operation: "update",
        version: 2,
        resource: expect.objectContaining({ content: "Updated synced entry" }),
      }),
      expect.objectContaining({
        resourceId: remoteIds["local-entry"],
        operation: "delete",
        version: 2,
      }),
    ]));
    expect((await request(`/api/v1/sync/pull?cursor=${encodeURIComponent(delta.data.nextCursor)}`))
      .data.changes).toHaveLength(0);
  });

  test("validates sync push envelopes, idempotency keys, and individual change shapes", async () => {
    const key = { "Idempotency-Key": "validation-key" };
    expectProblem(await request("/api/v1/sync/push", {
      method: "POST",
      body: { changes: [] },
    }), 400, "IDEMPOTENCY_KEY_REQUIRED");
    expectProblem(await request("/api/v1/sync/push", {
      method: "POST",
      headers: { "Idempotency-Key": "x".repeat(256) },
      body: { changes: [] },
    }), 400, "BAD_REQUEST");
    expectProblem(await request("/api/v1/sync/push", {
      method: "POST",
      headers: key,
      body: { changes: "not-an-array" },
    }), 422, "VALIDATION_ERROR");
    expectProblem(await request("/api/v1/sync/push", {
      method: "POST",
      headers: key,
      body: { changes: [], extra: true },
    }), 422, "VALIDATION_ERROR");

    const invalidChanges = [
      [null, "Each synchronization change must be an object."],
      [{ unsupported: true }, "Unsupported synchronization field unsupported."],
      [{ resourceType: "entry" }, "Each change requires a nonblank changeId."],
      [{ changeId: "change-1", resourceType: "unsupported" }, "Each change requires a supported resourceType."],
      [{ changeId: "change-1", resourceType: "entry", operation: "merge" }, "Each change requires a supported operation."],
      [{
        changeId: "change-1",
        resourceType: "entry",
        operation: "create",
        resource: { content: "Entry" },
      }, "Create changes require clientResourceId."],
      [{
        changeId: "change-1",
        resourceType: "entry",
        operation: "create",
        clientResourceId: "client-entry",
      }, "Create changes require a resource object."],
      [{
        changeId: "change-1",
        resourceType: "entry",
        operation: "create",
        clientResourceId: "client-entry",
        resource: [],
      }, "Create changes require a resource object."],
      [{
        changeId: "change-1",
        resourceType: "entry",
        operation: "update",
        baseVersion: 1,
        resource: { content: "Entry" },
      }, "Update and delete changes require resourceId."],
      [{
        changeId: "change-1",
        resourceType: "entry",
        operation: "delete",
        resourceId: "remote-entry",
        baseVersion: 0,
      }, "Update and delete changes require a positive baseVersion."],
      [{
        changeId: "change-1",
        resourceType: "entry",
        operation: "update",
        resourceId: "remote-entry",
        baseVersion: 1,
      }, "Update changes require a resource object."],
    ];

    for (const [change, detail] of invalidChanges) {
      const result = await request("/api/v1/sync/push", {
        method: "POST",
        headers: key,
        body: { changes: [change] },
      });
      expectProblem(result, 422, "VALIDATION_ERROR");
      expect(result.data.detail).toBe(detail);
    }

    const duplicate = {
      changeId: "duplicate-id",
      resourceType: "entry",
      operation: "create",
      clientResourceId: "client-entry",
      resource: { content: "Entry" },
    };
    expectProblem(await request("/api/v1/sync/push", {
      method: "POST",
      headers: key,
      body: { changes: [duplicate, duplicate] },
    }), 422, "VALIDATION_ERROR");
  });

  test("pushes all relationship resource types and applies resource update and association deletion", async () => {
    const changes = [
      {
        changeId: "entry-a",
        clientResourceId: "client-entry-a",
        resourceType: "entry",
        operation: "create",
        resource: { content: "First entry" },
      },
      {
        changeId: "entry-b",
        clientResourceId: "client-entry-b",
        resourceType: "entry",
        operation: "create",
        resource: { content: "Second entry" },
      },
      {
        changeId: "book",
        clientResourceId: "client-book",
        resourceType: "book",
        operation: "create",
        resource: { title: "Synced Book" },
      },
      {
        changeId: "tag",
        clientResourceId: "client-tag",
        resourceType: "tag",
        operation: "create",
        resource: { name: "Synced Tag" },
      },
      {
        changeId: "chapter",
        clientResourceId: "client-chapter",
        resourceType: "chapter",
        operation: "create",
        resource: { title: "Synced Chapter", bookId: "client-book" },
      },
      {
        changeId: "entry-tag",
        clientResourceId: "client-entry-tag",
        resourceType: "entryTagAssociation",
        operation: "create",
        resource: { entryId: "client-entry-a", tagId: "client-tag" },
      },
      {
        changeId: "entry-book",
        clientResourceId: "client-entry-book",
        resourceType: "entryBookAssociation",
        operation: "create",
        resource: { entryId: "client-entry-a", bookId: "client-book" },
      },
      {
        changeId: "entry-chapter",
        clientResourceId: "client-entry-chapter",
        resourceType: "entryChapterAssociation",
        operation: "create",
        resource: { entryId: "client-entry-a", chapterId: "client-chapter" },
      },
      {
        changeId: "entry-link",
        clientResourceId: "client-entry-link",
        resourceType: "entryLink",
        operation: "create",
        resource: { entryIdA: "client-entry-a", entryIdB: "client-entry-b" },
      },
    ];
    const pushed = await request("/api/v1/sync/push", {
      method: "POST",
      headers: { "Idempotency-Key": "all-resource-types" },
      body: { changes },
    });
    expect(pushed.response.status).toBe(200);
    const remoteIds = Object.fromEntries(
      pushed.data.results.map((result) => [result.changeId, result.resourceId]),
    );
    const pulled = await request("/api/v1/sync/pull");
    expect(pulled.data.changes.map((change) => change.resourceType)).toEqual(
      expect.arrayContaining([
        "entryTagAssociation",
        "entryBookAssociation",
        "entryChapterAssociation",
        "entryLink",
      ]),
    );

    const updated = await request("/api/v1/sync/push", {
      method: "POST",
      headers: { "Idempotency-Key": "update-tag" },
      body: {
        changes: [{
          changeId: "update-tag",
          resourceId: remoteIds.tag,
          resourceType: "tag",
          operation: "update",
          baseVersion: 1,
          resource: { name: "Updated Tag" },
        }],
      },
    });
    expect(updated.response.status).toBe(200);
    expect((await request(`/api/v1/tags/${remoteIds.tag}`)).data.name).toBe("Updated Tag");

    const deleted = await request("/api/v1/sync/push", {
      method: "POST",
      headers: { "Idempotency-Key": "delete-association" },
      body: {
        changes: [{
          changeId: "delete-association",
          resourceId: remoteIds["entry-tag"],
          resourceType: "entryTagAssociation",
          operation: "delete",
          baseVersion: 1,
        }],
      },
    });
    expect(deleted.response.status).toBe(200);
    expect((await request(`/api/v1/entry-tag-associations/${remoteIds["entry-tag"]}`, {
      method: "DELETE",
    })).response.status).toBe(404);
  });

  test("rejects oversized requests, invalid synchronization cursors, and unsupported sync methods", async () => {
    const oversized = await request("/api/v1/entries", {
      method: "POST",
      body: { content: "x".repeat(1024 * 1024) },
    });
    expectProblem(oversized, 413, "PAYLOAD_TOO_LARGE");
    expectProblem(await request("/api/v1/sync/pull?cursor=not-a-valid-cursor"), 400, "BAD_REQUEST");
    expectProblem(await request("/api/v1/sync/pull", { method: "POST" }), 405, "METHOD_NOT_ALLOWED");
    expectProblem(await request("/api/v1/entries", { token: null }), 401, "UNAUTHENTICATED");
  });

  test("isolates users and returns consistent validation, transport, method, and route errors", async () => {
    const ownerEntry = await createResource("/api/v1/entries", { content: "Private" });
    const email = `second-${randomUUID()}@example.test`;
    const password = "OtherUserPass123";
    await request("/api/v1/auth/register", {
      method: "POST",
      token: null,
      body: { email, password },
    });
    const login = await request("/api/v1/auth/login", {
      method: "POST",
      token: null,
      body: { email, password },
    });
    const otherUserToken = login.data.accessToken;
    const foreignEntry = await createResource(
      "/api/v1/entries",
      { content: "Other private" },
      { token: otherUserToken },
    );
    const otherUserRead = await request(`/api/v1/entries/${ownerEntry.data.id}`, {
      token: otherUserToken,
    });
    expectProblem(otherUserRead, 403, "FORBIDDEN");
    expectProblem(await request(`/api/v1/entries/${foreignEntry.data.id}`), 403, "FORBIDDEN");
    const secondUserList = await request("/api/v1/entries", { token: otherUserToken });
    expect(secondUserList.data.items.map((item) => item.id)).not.toContain(ownerEntry.data.id);
    const ownerTag = await createResource("/api/v1/tags", { name: "Owner Tag" });
    expectProblem(await request("/api/v1/entry-tag-associations", {
      method: "POST",
      body: { entryId: foreignEntry.data.id, tagId: ownerTag.data.id },
    }), 403, "FORBIDDEN");
    const otherTag = await createResource("/api/v1/tags", {
      name: "Other User Tag",
    }, { token: otherUserToken });
    const foreignAssociation = await createResource("/api/v1/entry-tag-associations", {
      entryId: foreignEntry.data.id,
      tagId: otherTag.data.id,
    }, { token: otherUserToken });
    expectProblem(await request(`/api/v1/entry-tag-associations/${foreignAssociation.data.id}`, {
      method: "DELETE",
    }), 403, "FORBIDDEN");

    expectProblem(await request("/api/v1/entries", {
      method: "POST",
      body: { content: " " },
    }), 422, "VALIDATION_ERROR");
    expectProblem(await request("/api/v1/tags", {
      method: "POST",
      body: { name: "   " },
    }), 422, "VALIDATION_ERROR");
    expectProblem(await request("/api/v1/entries", {
      method: "POST",
      body: { content: "Wrong media type" },
      headers: { "Content-Type": "text/plain" },
    }), 415, "UNSUPPORTED_MEDIA_TYPE");
    expectProblem(await request("/api/v1/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }), 400, "BAD_REQUEST");
    const malformedJson = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid",
    });
    expectProblem({
      response: malformedJson,
      data: await malformedJson.json(),
    }, 400, "BAD_REQUEST");
    const arrayBody = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "[]",
    });
    expectProblem({
      response: arrayBody,
      data: await arrayBody.json(),
    }, 422, "VALIDATION_ERROR");
    expectProblem(await request("/api/v1/entries", {
      method: "POST",
      body: { content: "Unexpected field", ownerId: "attacker" },
    }), 422, "VALIDATION_ERROR");
    expectProblem(await request("/api/v1/entries", {
      method: "DELETE",
    }), 405, "METHOD_NOT_ALLOWED");
    expectProblem(await request("/api/v1/unknown"), 404, "NOT_FOUND");
    expectProblem(await request("/api/v1/entries", {
      token: "invalid-token",
    }), 401, "UNAUTHENTICATED");

    const loggedRequest = logEvents.find(
      (event) => event.event === "http.request.completed" && event.status === 422,
    );
    expect(loggedRequest).toMatchObject({
      method: "POST",
      status: 422,
      userId: expect.any(String),
    });
    expect(loggedRequest.requestId).toBeTruthy();
  });
});
