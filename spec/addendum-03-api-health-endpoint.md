# Addendum 03 to the SRS: API Health Endpoint

## Status

Approved through SPEC-ADDENDUM-GATE by the project owner. WNT-18 is authorized
for implementation. This addendum adds a minimal public liveness endpoint to
the WNT-11 API; it does not define database readiness, deployment monitoring,
or a new client workflow.

## Rationale

The current API contract has no operation to determine whether the HTTP API
process is responding. A minimal health endpoint gives operators and local
development tooling a stable liveness check without requiring account
credentials or exposing user data and infrastructure details.

## Ticket

**WNT-18 — Add public API liveness endpoint**

**Goal:** Add and verify a lightweight HTTP endpoint that confirms that the
API process can accept and answer an HTTP request.

**Out of scope:** Database readiness checks, dependency diagnostics, uptime or
build metadata, authentication, deployment probes, and mobile-client UI.

## Requirement

### REQ-F-040 — API liveness

The API shall expose `GET /api/v1/health` without requiring authentication.
When the API process is running and able to handle the request, it shall
return HTTP `200 OK` with the JSON representation `{"status":"ok"}`. This
endpoint shall report API-process liveness only; it shall not imply that
SQLite or any other external dependency is ready. The response shall not
disclose credentials, configuration, database details, or user data.

Requests using a method other than `GET` at `/api/v1/health` shall be rejected
with HTTP `405 Method Not Allowed` and an `Allow: GET` header.

## Acceptance criterion

### AC-F-040

Given the API server is running, when a client sends an unauthenticated
`GET /api/v1/health`, then the server returns `200 OK`, an
`application/json` content type, and exactly `{"status":"ok"}`. The response
contains no environment, database, credential, or user-specific information.
When a client sends a non-GET request to `/api/v1/health`, the server returns
`405 Method Not Allowed` with `Allow: GET`.

## OpenAPI contract

`openapi.yaml` adds the public `GET /api/v1/health` operation and its
`HealthResponse` schema. The operation has no bearer-auth requirement. No
existing resource, authentication, or synchronization operation changes.

## Impact on existing artifacts

| Artifact | Impact |
|---|---|
| `spec/openapi.yaml` | Add `GET /api/v1/health`, the `Health` tag, `REQ-F-040` metadata, and the response schema. No existing operation changes. |
| `spec/srs.tex` | No in-place edit is made by this addendum. This approved addendum is the authoritative extension for `REQ-F-040` and `AC-F-040`; the baseline SRS may be consolidated later under the project owner's direction. |
| Traceability matrix | The matrix now maps `REQ-F-040` / `AC-F-040` to WNT-18 and records the planned health endpoint tests and API implementation. Implementation evidence remains pending. |
| Backend implementation | Add an unauthenticated `/api/v1/health` route before protected-route authentication. Do not query SQLite as part of this liveness endpoint. |
| Tests | Add positive unauthenticated GET and negative unsupported-method cases to the WNT-11 integration suite. Verify exact response shape and absence of sensitive detail. |
| Logs and project plan | Record SPEC-ADDENDUM-GATE disposition and WNT-18 implementation evidence in `logs/`. Add WNT-18 to the project schedule only after scope approval and scheduling by the project owner. |
| Mobile app and sync protocol | No impact. No change to authentication, OpenAPI resource CRUD, offline behavior, or synchronization payloads. |

## Compatibility, security, and verification notes

The endpoint is additive and public, so it remains usable before login and
does not change existing clients. Its response is deliberately static and
minimal. It is a liveness signal only, not a readiness guarantee; monitoring
that needs database-readiness semantics requires a separate requirement and
contract decision.

The implementation is expected to use the normal HTTP request logging path.
The response itself must not disclose secrets or operational configuration.
