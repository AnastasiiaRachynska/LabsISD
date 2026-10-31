# Addendum 01 to SRS: Chapter Resource URI Hierarchy

## Context

Section 3.1.3, **Communications Interfaces**, lists `/chapters` among the versioned resource endpoints. REQ-F-032 specifies Chapter CRUD operations through `/api/v1/chapters` while requiring the Chapter's parent-Book relationship. The domain glossary defines a Chapter as a named subdivision of a Book.

This addendum clarifies the Chapter URI hierarchy and its HTTP methods. It refines how the existing parent relationship is represented in the API and does not change the required Chapter capabilities.

## Current wording of REQ-F-032

> **REQ-F-032:** The backend API shall allow the client to create, retrieve, update, and delete Chapters through the `/api/v1/chapters` resource, including their parent-Book relationship.

## Clarification to Section 3.1.3

The flat Chapter collection path `/api/v1/chapters` is superseded as the canonical route. Chapter collections shall be nested under their parent Book:

- **Chapter collection:** `/api/v1/books/{bookId}/chapters`
- **Chapter item:** `/api/v1/books/{bookId}/chapters/{chapterId}`

The `bookId` path parameter identifies the parent Book, and `chapterId` identifies a Chapter within it. The API shall support these operations:

- **`GET /api/v1/books/{bookId}/chapters`** — Retrieve the Chapters belonging to the identified Book.
- **`POST /api/v1/books/{bookId}/chapters`** — Create a Chapter under the identified Book.
- **`GET /api/v1/books/{bookId}/chapters/{chapterId}`** — Retrieve the identified Chapter.
- **`PUT /api/v1/books/{bookId}/chapters/{chapterId}`** — Replace the identified Chapter representation.
- **`PATCH /api/v1/books/{bookId}/chapters/{chapterId}`** — Partially update the identified Chapter.
- **`DELETE /api/v1/books/{bookId}/chapters/{chapterId}`** — Delete the identified Chapter without deleting its associated Entries.

## Refined requirement

**REQ-F-032:** The backend API shall allow the client to create, retrieve, update, and delete Chapters through the nested `/api/v1/books/{bookId}/chapters` resource, including their parent-Book relationship. The Chapter item URI shall be `/api/v1/books/{bookId}/chapters/{chapterId}`.

## Technical and architectural rationale

Nesting Chapters under Books makes the containment relationship explicit in the URI and aligns the API structure with the domain glossary. It gives clients a consistent way to retrieve a Book's Chapters and create a Chapter in the context of its parent, rather than relying solely on a separate parent identifier.

Using one canonical nested route avoids ambiguity and divergent behavior that could result from supporting both flat and nested Chapter routes. This URI refinement preserves the existing Chapter CRUD behavior, the parent-Book relationship, and the safe-detach rule: deleting a Chapter does not delete associated Entries.
