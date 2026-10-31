# Addendum 02: User Authentication & User-Scoped Sync (New Requirement Scope)

## Status and scope

This addendum extends the approved Software Requirements Specification (SRS) with account authentication and per-user server-side data isolation. It supersedes the earlier SRS statement that account identity, authentication, and authorization behavior were unspecified. It does not change the offline-first behavior or the existing Entry, Book, Chapter, Tag, association, and Entry Link resource requirements.

The OpenAPI specification in `openapi.yaml` specifies the request and response representations and status codes introduced by this addendum.

## New functional requirements

### REQ-F-038 — Account authentication

The system shall provide email-and-password account registration and login, issue a JWT access token and a refresh token after successful authentication, allow a valid refresh token to obtain a new access token, and provide the authenticated user's profile. Passwords shall contain at least 8 characters. Access tokens shall expire 900 seconds after issuance. Each successful refresh shall issue a new refresh token and invalidate the refresh token used. The API shall expose these operations:

- `POST /api/v1/auth/register` — register an account.
- `POST /api/v1/auth/login` — authenticate credentials and issue tokens.
- `POST /api/v1/auth/refresh` — exchange a valid refresh token for a new access token and refresh token.
- `GET /api/v1/auth/me` — retrieve the profile associated with the presented access token.

The access token shall identify the authenticated user by setting the JWT `sub` claim to that user's `userId`. Register, login, and refresh are credential-exchange endpoints and do not require an access-token `Authorization` header. The profile endpoint and all other protected endpoints require a valid access token. The request and response schemas are defined in `openapi.yaml`.

### REQ-F-039 — User-scoped data isolation

The server shall strictly scope all server-side domain records, associations, Entry Links, and synchronization state to the authenticated user. For every protected request, the server shall derive `userId` from the validated JWT access token and use it as the ownership boundary. The server shall not accept a client-supplied `userId` as authority to select or change ownership. A user shall not retrieve, modify, delete, associate, link, push, or pull another user's data.

The server shall reject attempts to reference another user's records with `403 Forbidden`. Synchronization cursors and change acknowledgements shall be usable only within the authenticated user's scope. User-scoped isolation shall apply to both online API operations and offline changes when they are synchronized.

## Authorization convention

Every request to an Entry, Book, Chapter, Tag, association, Entry Link, or synchronization endpoint shall include:

```http
Authorization: Bearer <access_token>
```

Missing, invalid, or expired access tokens shall produce `401 Unauthorized`. A valid token that attempts to access data owned by a different user shall produce `403 Forbidden`. Authentication and authorization errors shall use the unified error response defined in the REST API contract.

## Synchronization and ownership

`POST /api/v1/sync/push` shall apply accepted changes only to records owned by the authenticated user. A pushed change may not create or alter a relationship to another user's resource. Each acknowledgement shall refer only to a change in that user's scope.

`GET /api/v1/sync/pull?cursor={cursor}` shall return changes belonging only to the authenticated user. A cursor shall be bound to the user for whom it was issued and shall not permit access to another user's change stream. The server shall reject a cursor used outside its owner's scope.

## Relationship to existing SRS requirements

This addendum extends REQ-F-030 through REQ-F-037. It does not change their resource paths, CRUD behavior, sync operations, version-conflict handling, or relationship semantics. REQ-F-038 and REQ-F-039 add the authentication and ownership requirements that apply across those existing operations.
