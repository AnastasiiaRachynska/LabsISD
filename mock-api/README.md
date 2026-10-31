# Stateful contract mock

This dependency-free Node.js mock keeps API data in memory while it is running.
It implements the OpenAPI routes with user-scoped resources, CRUD operations,
ETag preconditions, authentication, relationships, and sync cursors. Restarting
the process resets the mock data; it is intended for contract testing, not as a
production server.

Start it from the repository root:

```powershell
node mock-api\server.js
```

The default address is `http://127.0.0.1:4011`. The seeded test account is
`writer@example.com` / `ExamplePass123`; Schemathesis can use the seeded bearer
token `schemathesis-test-token`. `PORT` and `STATEFUL_MOCK_TOKEN` can override
the defaults.

Run coverage, fuzzing, and stateful OpenAPI link sequences without the project
test script:

```powershell
st run spec\openapi.yaml `
  --url http://127.0.0.1:4011 `
  -H "Authorization: Bearer schemathesis-test-token" `
  --phases coverage,fuzzing,stateful `
  --exclude-checks positive_data_acceptance `
  --max-examples 5 `
  --max-time 60 `
  --workers 1
```

`positive_data_acceptance` is excluded because `If-Match` is optional in the
request schema so the required missing-header behavior can be tested; the
contract intentionally returns `428` when it is omitted. Other response,
schema, negative-input, and stateful checks remain enabled.

The resource links in the OpenAPI document let Schemathesis create resources,
read them, update or delete them using returned ETags, and follow up with reads.
This allows stateful checks to detect behaviors such as a deleted resource
still being returned.
