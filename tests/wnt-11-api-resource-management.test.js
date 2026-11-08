"use strict";

const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const repositoryRoot = path.resolve(__dirname, "..");
const srs = fs.readFileSync(path.join(repositoryRoot, "spec/srs.tex"), "utf8");
const openApi = fs.readFileSync(path.join(repositoryRoot, "spec/openapi.yaml"), "utf8");
const traceabilityMatrix = fs.readFileSync(
  path.join(repositoryRoot, "spec/traceability-matrix.tex"),
  "utf8",
);
const requirementMap = [
  ["REQ-F-030", "AC-F-030"],
  ["REQ-F-031", "AC-F-031"],
  ["REQ-F-032", "AC-F-032"],
  ["REQ-F-033", "AC-F-033"],
  ["REQ-F-034", "AC-F-034"],
];
const token = "schemathesis-test-token";
const headers = { Authorization: `Bearer ${token}` };

let serverProcess;
let baseUrl;

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const { port } = listener.address();
      listener.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`API mock exited with code ${serverProcess.exitCode}.`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/entries`, { headers });
      if (response.ok) {
        return;
      }
    } catch (error) {
      if (attempt === 49) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("API mock did not become ready.");
}

async function api(pathname, { method = "GET", body, headers: extraHeaders = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    response,
    data: text ? JSON.parse(text) : undefined,
  };
}

async function createResource(pathname, body) {
  const result = await api(pathname, { method: "POST", body });
  expect(result.response.status).toBe(201);
  return result;
}

function expectProblem(result, status, code) {
  expect(result.response.status).toBe(status);
  expect(result.response.headers.get("content-type")).toContain("application/problem+json");
  expect(result.data).toMatchObject({ status, code });
}

function resourceId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

beforeAll(async () => {
  const port = await getAvailablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [path.join(repositoryRoot, "mock-api", "server.js")], {
    env: { ...process.env, PORT: String(port), STATEFUL_MOCK_TOKEN: token },
    stdio: "ignore",
  });
  await waitForServer();
});

afterAll(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    const exited = once(serverProcess, "exit");
    serverProcess.kill();
    await exited;
  }
});

describe("WNT-11 SRS and OpenAPI traceability", () => {
  test.each(requirementMap)("%s maps to %s and WNT-11", (requirementId, criterionId) => {
    expect(srs).toContain(requirementId);
    expect(srs).toContain(criterionId);
    expect(openApi).toContain(requirementId);

    const row = traceabilityMatrix
      .split(/\r?\n/)
      .find((line) => line.includes(`${requirementId} & ${criterionId}`));
    expect(row).toContain("WNT-11");
  });
});

describe("WNT-11 API resource acceptance", () => {
  test("[REQ-F-030] creates, reads, updates, and deletes an Entry with version preconditions", async () => {
    const created = await createResource("/api/v1/entries", {
      content: "Initial API Entry",
      entryType: "General Note",
    });
    expect(created.data).toMatchObject({
      version: 1,
      content: "Initial API Entry",
      entryType: "General Note",
    });
    expect(created.data.ownerId).toBeUndefined();

    const entryUrl = `/api/v1/entries/${created.data.id}`;
    const retrieved = await api(entryUrl);
    expect(retrieved.response.status).toBe(200);
    expect(retrieved.data).toMatchObject({ id: created.data.id, version: 1 });

    const updated = await api(entryUrl, {
      method: "PATCH",
      body: { content: "Updated API Entry" },
      headers: { "If-Match": retrieved.response.headers.get("etag") },
    });
    expect(updated.response.status).toBe(200);
    expect(updated.data).toMatchObject({ content: "Updated API Entry", version: 2 });

    const staleUpdate = await api(entryUrl, {
      method: "PATCH",
      body: { content: "Stale change" },
      headers: { "If-Match": retrieved.response.headers.get("etag") },
    });
    expect(staleUpdate.response.status).toBe(412);

    const deleted = await api(entryUrl, {
      method: "DELETE",
      headers: { "If-Match": updated.response.headers.get("etag") },
    });
    expect(deleted.response.status).toBe(204);
    expect((await api(entryUrl)).response.status).toBe(404);
  });

  test("[REQ-F-031, REQ-F-032] manages Books and nested Chapters without losing Entries", async () => {
    const book = await createResource("/api/v1/books", { title: "API Book" });
    const bookUrl = `/api/v1/books/${book.data.id}`;
    const retrievedBook = await api(bookUrl);
    expect(retrievedBook.data.title).toBe("API Book");
    const updatedBook = await api(bookUrl, {
      method: "PATCH",
      body: { title: "Updated API Book" },
      headers: { "If-Match": retrievedBook.response.headers.get("etag") },
    });
    expect(updatedBook.data.title).toBe("Updated API Book");

    const entry = await createResource("/api/v1/entries", { content: "Surviving Entry" });
    const directAssociation = await createResource("/api/v1/entry-book-associations", {
      entryId: entry.data.id,
      bookId: book.data.id,
    });
    expect(directAssociation.data.source).toBe("direct");

    const chapter = await createResource(`${bookUrl}/chapters`, { title: "API Chapter" });
    expect(chapter.data.bookId).toBe(book.data.id);
    const chapterUrl = `${bookUrl}/chapters/${chapter.data.id}`;
    const retrievedChapter = await api(chapterUrl);
    expect(retrievedChapter.data).toMatchObject({
      id: chapter.data.id,
      bookId: book.data.id,
      title: "API Chapter",
    });

    const updatedChapter = await api(chapterUrl, {
      method: "PATCH",
      body: { title: "Updated Chapter" },
      headers: { "If-Match": retrievedChapter.response.headers.get("etag") },
    });
    expect(updatedChapter.data.title).toBe("Updated Chapter");
    const deletedChapter = await api(chapterUrl, {
      method: "DELETE",
      headers: { "If-Match": updatedChapter.response.headers.get("etag") },
    });
    expect(deletedChapter.response.status).toBe(204);
    expect((await api(chapterUrl)).response.status).toBe(404);

    const deletedBook = await api(bookUrl, {
      method: "DELETE",
      headers: { "If-Match": updatedBook.response.headers.get("etag") },
    });
    expect(deletedBook.response.status).toBe(204);
    expect((await api(bookUrl)).response.status).toBe(404);
    expect((await api(`/api/v1/entries/${entry.data.id}`)).response.status).toBe(200);
    const remainingAssociations = await api(
      `/api/v1/entry-book-associations?entryId=${entry.data.id}`,
    );
    expect(remainingAssociations.data.items).toHaveLength(0);
  });

  test("[REQ-F-033] deletes a Tag and its assignments but preserves the Entry", async () => {
    const entry = await createResource("/api/v1/entries", { content: "Tagged Entry" });
    const tag = await createResource("/api/v1/tags", { name: "API Tag" });
    expect((await api(`/api/v1/tags/${tag.data.id}`)).data.name).toBe("API Tag");
    const updatedTag = await api(`/api/v1/tags/${tag.data.id}`, {
      method: "PATCH",
      body: { name: "Updated API Tag" },
      headers: { "If-Match": tag.response.headers.get("etag") },
    });
    expect(updatedTag.data.name).toBe("Updated API Tag");

    await createResource("/api/v1/entry-tag-associations", {
      entryId: entry.data.id,
      tagId: tag.data.id,
    });
    const assignmentsUrl = `/api/v1/entry-tag-associations?entryId=${entry.data.id}`;
    expect((await api(assignmentsUrl)).data.items).toHaveLength(1);

    const deletedTag = await api(`/api/v1/tags/${tag.data.id}`, {
      method: "DELETE",
      headers: { "If-Match": updatedTag.response.headers.get("etag") },
    });
    expect(deletedTag.response.status).toBe(204);
    expect((await api(assignmentsUrl)).data.items).toHaveLength(0);
    expect((await api(`/api/v1/entries/${entry.data.id}`)).response.status).toBe(200);
  });

  test("[REQ-F-034] preserves direct and Chapter-derived relationships and symmetric links", async () => {
    const book = await createResource("/api/v1/books", { title: "Relationship Book" });
    const chapter = await createResource(
      `/api/v1/books/${book.data.id}/chapters`,
      { title: "Relationship Chapter" },
    );
    const directlyAndByChapter = await createResource("/api/v1/entries", {
      content: "Direct and Chapter Entry",
    });
    const direct = await createResource("/api/v1/entry-book-associations", {
      entryId: directlyAndByChapter.data.id,
      bookId: book.data.id,
    });
    const chapterAssociation = await createResource("/api/v1/entry-chapter-associations", {
      entryId: directlyAndByChapter.data.id,
      chapterId: chapter.data.id,
    });
    expect(chapterAssociation.data).toMatchObject({
      entryId: directlyAndByChapter.data.id,
      chapterId: chapter.data.id,
      bookId: book.data.id,
    });

    const chapterOnlyEntry = await createResource("/api/v1/entries", {
      content: "Chapter-only Entry",
    });
    const chapterOnlyAssociation = await createResource("/api/v1/entry-chapter-associations", {
      entryId: chapterOnlyEntry.data.id,
      chapterId: chapter.data.id,
    });
    expect(chapterOnlyAssociation.data.bookId).toBe(book.data.id);

    const removal = await api(
      `/api/v1/entry-chapter-associations/${chapterOnlyAssociation.data.id}`,
      { method: "DELETE" },
    );
    expect(removal.response.status).toBe(204);
    expect((await api(`/api/v1/entries/${chapterOnlyEntry.data.id}`)).response.status).toBe(200);
    expect((await api(`/api/v1/entry-book-associations?entryId=${directlyAndByChapter.data.id}`))
      .data.items).toEqual([expect.objectContaining({ id: direct.data.id, source: "direct" })]);

    const secondEntry = await createResource("/api/v1/entries", {
      content: "Linked Entry",
    });
    const link = await createResource("/api/v1/entry-links", {
      entryIdA: directlyAndByChapter.data.id,
      entryIdB: secondEntry.data.id,
    });
    expect(link.data.entryIds).toEqual(
      [directlyAndByChapter.data.id, secondEntry.data.id].sort(),
    );
    for (const entry of [directlyAndByChapter, secondEntry]) {
      const links = await api(`/api/v1/entry-links?entryId=${entry.data.id}`);
      expect(links.data.items).toContainEqual(expect.objectContaining({ id: link.data.id }));
    }

    expect((await api(`/api/v1/entry-chapter-associations?entryId=${chapterOnlyEntry.data.id}`))
      .data.items).toHaveLength(0);
    expect((await api(`/api/v1/entry-chapter-associations/${chapterAssociation.data.id}`, {
      method: "DELETE",
    })).response.status).toBe(204);
    expect((await api(`/api/v1/entry-book-associations/${direct.data.id}`, {
      method: "DELETE",
    })).response.status).toBe(204);
    expect((await api(`/api/v1/entry-links/${link.data.id}`, { method: "DELETE" }))
      .response.status).toBe(204);
    expect((await api(`/api/v1/entry-links?entryId=${secondEntry.data.id}`)).data.items)
      .toHaveLength(0);
    expect((await api(`/api/v1/entries/${directlyAndByChapter.data.id}`)).response.status).toBe(200);
    expect((await api(`/api/v1/entries/${secondEntry.data.id}`)).response.status).toBe(200);
  });

  test("replaces every resource type and enforces version preconditions", async () => {
    const book = await createResource("/api/v1/books", { title: "PUT Parent Book" });
    const resources = [
      {
        collection: "/api/v1/entries",
        detail: (id) => `/api/v1/entries/${id}`,
        initial: { content: "PUT Entry" },
        replacement: { content: "Replaced Entry", entryType: "Scene" },
        property: "content",
      },
      {
        collection: "/api/v1/books",
        detail: (id) => `/api/v1/books/${id}`,
        initial: { title: "PUT Book" },
        replacement: { title: "Replaced Book" },
        property: "title",
      },
      {
        collection: `/api/v1/books/${book.data.id}/chapters`,
        detail: (id) => `/api/v1/books/${book.data.id}/chapters/${id}`,
        initial: { title: "PUT Chapter" },
        replacement: { title: "Replaced Chapter" },
        property: "title",
      },
      {
        collection: "/api/v1/tags",
        detail: (id) => `/api/v1/tags/${id}`,
        initial: { name: "PUT Tag" },
        replacement: { name: "Replaced Tag" },
        property: "name",
      },
    ];

    for (const resource of resources) {
      const created = await createResource(resource.collection, resource.initial);
      expect(created.response.headers.get("location")).toBe(
        `${resource.collection}/${created.data.id}`,
      );
      expect(created.response.headers.get("etag")).toBe('"1"');
      const detailUrl = resource.detail(created.data.id);
      const retrieved = await api(detailUrl);
      expect(retrieved.response.headers.get("etag")).toBe('"1"');

      expectProblem(await api(detailUrl, {
        method: "PATCH",
        body: resource.replacement,
      }), 428, "PRECONDITION_REQUIRED");
      expectProblem(await api(detailUrl, {
        method: "PUT",
        body: resource.replacement,
        headers: { "If-Match": "1" },
      }), 400, "INVALID_IF_MATCH");

      const replaced = await api(detailUrl, {
        method: "PUT",
        body: resource.replacement,
        headers: { "If-Match": retrieved.response.headers.get("etag") },
      });
      expect(replaced.response.status).toBe(200);
      expect(replaced.data[resource.property]).toBe(
        resource.replacement[resource.property],
      );
      expect(replaced.response.headers.get("etag")).toBe('"2"');
      expectProblem(await api(detailUrl, {
        method: "PATCH",
        body: resource.replacement,
        headers: { "If-Match": retrieved.response.headers.get("etag") },
      }), 412, "PRECONDITION_FAILED");
    }
  });

  test("paginates collections, applies association filters, and rejects invalid paging", async () => {
    const entries = await Promise.all([
      createResource("/api/v1/entries", { content: "Paging Entry One" }),
      createResource("/api/v1/entries", { content: "Paging Entry Two" }),
      createResource("/api/v1/entries", { content: "Paging Entry Three" }),
    ]);
    const book = await createResource("/api/v1/books", { title: "Paging Book" });
    const chapters = await Promise.all([
      createResource(`/api/v1/books/${book.data.id}/chapters`, { title: "Paging Chapter One" }),
      createResource(`/api/v1/books/${book.data.id}/chapters`, { title: "Paging Chapter Two" }),
    ]);
    const tags = await Promise.all([
      createResource("/api/v1/tags", { name: "Paging Tag One" }),
      createResource("/api/v1/tags", { name: "Paging Tag Two" }),
    ]);
    const firstTagAssociation = await createResource("/api/v1/entry-tag-associations", {
      entryId: entries[0].data.id,
      tagId: tags[0].data.id,
    });
    await createResource("/api/v1/entry-tag-associations", {
      entryId: entries[1].data.id,
      tagId: tags[1].data.id,
    });
    const firstBookAssociation = await createResource("/api/v1/entry-book-associations", {
      entryId: entries[0].data.id,
      bookId: book.data.id,
    });
    await createResource("/api/v1/entry-book-associations", {
      entryId: entries[1].data.id,
      bookId: book.data.id,
    });
    const firstChapterAssociation = await createResource("/api/v1/entry-chapter-associations", {
      entryId: entries[0].data.id,
      chapterId: chapters[0].data.id,
    });
    await createResource("/api/v1/entry-chapter-associations", {
      entryId: entries[1].data.id,
      chapterId: chapters[1].data.id,
    });
    const firstLink = await createResource("/api/v1/entry-links", {
      entryIdA: entries[0].data.id,
      entryIdB: entries[1].data.id,
    });
    await createResource("/api/v1/entry-links", {
      entryIdA: entries[1].data.id,
      entryIdB: entries[2].data.id,
    });

    const pagedCollections = [
      "/api/v1/entries",
      "/api/v1/books",
      `/api/v1/books/${book.data.id}/chapters`,
      "/api/v1/tags",
      "/api/v1/entry-tag-associations",
      "/api/v1/entry-book-associations",
      "/api/v1/entry-chapter-associations",
      "/api/v1/entry-links",
    ];
    for (const collection of pagedCollections) {
      const firstPage = await api(`${collection}?limit=1`);
      expect(firstPage.response.status).toBe(200);
      expect(firstPage.data.items).toHaveLength(1);
      expect(firstPage.data.nextCursor).toMatch(/^page-\d+$/);
      const secondPage = await api(
        `${collection}?limit=1&cursor=${encodeURIComponent(firstPage.data.nextCursor)}`,
      );
      expect(secondPage.response.status).toBe(200);
      expect(secondPage.data.items).toHaveLength(1);
      expect(secondPage.data.items[0].id).not.toBe(firstPage.data.items[0].id);
    }

    const filters = [
      [
        `/api/v1/entry-tag-associations?entryId=${entries[0].data.id}&tagId=${tags[0].data.id}`,
        firstTagAssociation.data.id,
      ],
      [
        `/api/v1/entry-book-associations?entryId=${entries[0].data.id}&bookId=${book.data.id}`,
        firstBookAssociation.data.id,
      ],
      [
        `/api/v1/entry-chapter-associations?entryId=${entries[0].data.id}&bookId=${book.data.id}&chapterId=${chapters[0].data.id}`,
        firstChapterAssociation.data.id,
      ],
      [`/api/v1/entry-links?entryId=${entries[0].data.id}`, firstLink.data.id],
    ];
    for (const [pathname, expectedId] of filters) {
      const filtered = await api(pathname);
      expect(filtered.data.items.map((item) => item.id)).toEqual([expectedId]);
    }

    for (const query of ["limit=0", "limit=101", "limit=1.5"]) {
      expectProblem(await api(`/api/v1/entries?${query}`), 400, "INVALID_PAGINATION");
    }
    expectProblem(await api("/api/v1/entries?cursor=unknown"), 400, "INVALID_CURSOR");
    for (const pathname of [
      "/api/v1/entry-tag-associations?entryId=",
      "/api/v1/entry-book-associations?bookId=",
      "/api/v1/entry-chapter-associations?bookId=",
      "/api/v1/entry-links?entryId=",
    ]) {
      expectProblem(await api(pathname), 400, "INVALID_FILTER");
    }
  });

  test("rejects duplicate or invalid associations and reports missing records", async () => {
    const entry = await createResource("/api/v1/entries", { content: "Association Entry" });
    const otherEntry = await createResource("/api/v1/entries", { content: "Other Association Entry" });
    const tag = await createResource("/api/v1/tags", { name: "Association Tag" });
    const book = await createResource("/api/v1/books", { title: "Association Book" });
    const chapter = await createResource(
      `/api/v1/books/${book.data.id}/chapters`,
      { title: "Association Chapter" },
    );
    const associations = [
      {
        path: "/api/v1/entry-tag-associations",
        body: { entryId: entry.data.id, tagId: tag.data.id },
        invalid: { entryId: entry.data.id, tagId: resourceId("missing-tag") },
      },
      {
        path: "/api/v1/entry-book-associations",
        body: { entryId: entry.data.id, bookId: book.data.id },
        invalid: { entryId: entry.data.id, bookId: resourceId("missing-book") },
      },
      {
        path: "/api/v1/entry-chapter-associations",
        body: { entryId: entry.data.id, chapterId: chapter.data.id },
        invalid: { entryId: entry.data.id, chapterId: resourceId("missing-chapter") },
      },
    ];
    for (const association of associations) {
      const created = await createResource(association.path, association.body);
      expectProblem(await api(association.path, {
        method: "POST",
        body: association.body,
      }), 409, "DUPLICATE_RELATIONSHIP");
      expectProblem(await api(association.path, {
        method: "POST",
        body: association.invalid,
      }), 404, "RESOURCE_NOT_FOUND");
      const associationUrl = `${association.path}/${created.data.id}`;
      expect((await api(associationUrl, { method: "DELETE" })).response.status).toBe(204);
      expectProblem(await api(associationUrl, { method: "DELETE" }), 404, "RESOURCE_NOT_FOUND");
    }

    const linkBody = { entryIdA: entry.data.id, entryIdB: otherEntry.data.id };
    const link = await createResource("/api/v1/entry-links", linkBody);
    expectProblem(await api("/api/v1/entry-links", {
      method: "POST",
      body: { entryIdA: otherEntry.data.id, entryIdB: entry.data.id },
    }), 409, "DUPLICATE_RELATIONSHIP");
    expectProblem(await api("/api/v1/entry-links", {
      method: "POST",
      body: { entryIdA: entry.data.id, entryIdB: entry.data.id },
    }), 422, "VALIDATION_ERROR");
    expectProblem(await api("/api/v1/entry-links", {
      method: "POST",
      body: { entryIdA: entry.data.id, entryIdB: resourceId("missing-entry") },
    }), 404, "RESOURCE_NOT_FOUND");
    const linkUrl = `/api/v1/entry-links/${link.data.id}`;
    expect((await api(linkUrl, { method: "DELETE" })).response.status).toBe(204);
    expectProblem(await api(linkUrl, { method: "DELETE" }), 404, "RESOURCE_NOT_FOUND");
  });

  test("keeps resource reads and lists isolated between authenticated users", async () => {
    const ownerEntry = await createResource("/api/v1/entries", { content: "Owner-only Entry" });
    const email = `${resourceId("api-user")}@example.test`;
    const password = "ContractTestPass123";
    expect((await api("/api/v1/auth/register", {
      method: "POST",
      body: { email, password },
    })).response.status).toBe(201);
    const login = await api("/api/v1/auth/login", {
      method: "POST",
      body: { email, password },
    });
    expect(login.response.status).toBe(200);
    const otherUserHeaders = { Authorization: `Bearer ${login.data.accessToken}` };
    const otherUserEntry = await api("/api/v1/entries", {
      method: "POST",
      body: { content: "Other user's Entry" },
      headers: otherUserHeaders,
    });
    expect(otherUserEntry.response.status).toBe(201);

    expectProblem(await api(`/api/v1/entries/${ownerEntry.data.id}`, {
      headers: otherUserHeaders,
    }), 403, "FORBIDDEN");
    expectProblem(await api(`/api/v1/entries/${otherUserEntry.data.id}`), 403, "FORBIDDEN");
    const ownerList = await api("/api/v1/entries");
    const otherUserList = await api("/api/v1/entries", { headers: otherUserHeaders });
    expect(ownerList.data.items.map((item) => item.id)).toContain(ownerEntry.data.id);
    expect(ownerList.data.items.map((item) => item.id)).not.toContain(otherUserEntry.data.id);
    expect(otherUserList.data.items.map((item) => item.id)).toContain(otherUserEntry.data.id);
    expect(otherUserList.data.items.map((item) => item.id)).not.toContain(ownerEntry.data.id);
  });

  test("removes all Entry relationships on deletion while retaining related resources", async () => {
    const entry = await createResource("/api/v1/entries", { content: "Deleted Association Entry" });
    const retainedEntry = await createResource("/api/v1/entries", { content: "Retained Link Entry" });
    const tag = await createResource("/api/v1/tags", { name: "Retained Association Tag" });
    const book = await createResource("/api/v1/books", { title: "Retained Association Book" });
    const chapter = await createResource(
      `/api/v1/books/${book.data.id}/chapters`,
      { title: "Retained Association Chapter" },
    );
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

    const deleted = await api(`/api/v1/entries/${entry.data.id}`, {
      method: "DELETE",
      headers: { "If-Match": entry.response.headers.get("etag") },
    });
    expect(deleted.response.status).toBe(204);
    for (const pathname of [
      `/api/v1/entry-tag-associations?entryId=${entry.data.id}`,
      `/api/v1/entry-book-associations?entryId=${entry.data.id}`,
      `/api/v1/entry-chapter-associations?entryId=${entry.data.id}`,
      `/api/v1/entry-links?entryId=${entry.data.id}`,
    ]) {
      expect((await api(pathname)).data.items).toHaveLength(0);
    }
    for (const pathname of [
      `/api/v1/entries/${retainedEntry.data.id}`,
      `/api/v1/tags/${tag.data.id}`,
      `/api/v1/books/${book.data.id}`,
      `/api/v1/books/${book.data.id}/chapters/${chapter.data.id}`,
    ]) {
      expect((await api(pathname)).response.status).toBe(200);
    }
  });

  test("rejects unsupported media, methods, unknown routes, and cross-Book Chapters", async () => {
    const book = await createResource("/api/v1/books", { title: "Scoped Chapter Book" });
    const otherBook = await createResource("/api/v1/books", { title: "Other Chapter Book" });
    const chapter = await createResource(
      `/api/v1/books/${book.data.id}/chapters`,
      { title: "Scoped Chapter" },
    );
    const wrongParentUrl = `/api/v1/books/${otherBook.data.id}/chapters/${chapter.data.id}`;
    expectProblem(await api(wrongParentUrl), 404, "RESOURCE_NOT_FOUND");
    expectProblem(await api(`/api/v1/books/${resourceId("missing-book")}/chapters`, {
      method: "POST",
      body: { title: "Orphan Chapter" },
    }), 404, "RESOURCE_NOT_FOUND");

    expectProblem(await api("/api/v1/entries", {
      method: "POST",
      body: { content: "Unsupported content type" },
      headers: { "Content-Type": "text/plain" },
    }), 415, "UNSUPPORTED_MEDIA_TYPE");
    expectProblem(await api(`/api/v1/entries/${resourceId("missing-entry")}`, {
      method: "POST",
      body: { content: "Unsupported method" },
    }), 405, "METHOD_NOT_ALLOWED");
    expectProblem(await api("/api/v1/unknown-resource"), 404, "ROUTE_NOT_FOUND");
    expect((await api(`/api/v1/books/${book.data.id}/chapters/${chapter.data.id}`))
      .response.status).toBe(200);
  });

  test("rejects unauthenticated access and invalid Entry Content", async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/v1/entries`);
    expect(unauthenticated.status).toBe(401);

    const invalidEntry = await api("/api/v1/entries", {
      method: "POST",
      body: { content: "   " },
    });
    expectProblem(invalidEntry, 422, "VALIDATION_ERROR");
    expectProblem(await api("/api/v1/books", {
      method: "POST",
      body: { title: " " },
    }), 422, "VALIDATION_ERROR");
    expectProblem(await api("/api/v1/tags", {
      method: "POST",
      body: { name: "" },
    }), 422, "VALIDATION_ERROR");
  });
});
