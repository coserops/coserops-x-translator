# x-translator-server

Translation backend scaffold based on Cloudflare's
[chanfana-openapi-template](https://github.com/cloudflare/templates/tree/main/chanfana-openapi-template).
Uses TypeScript, Hono, Chanfana, D1, and Vitest.

This project currently retains the template's task CRUD and dummy endpoints.
Translation, authentication, and usage limits are not implemented yet. Do not
use this scaffold as a public production translation service.

## Local development

Use Node.js 22 or newer and npm. From this repository's root:

```sh
cd x-translator-server
npm ci
npm run dev
```

The dev command applies migrations to local D1 storage before starting the
Worker. It does not modify a remote database. Open `http://localhost:8787/`
for interactive API documentation, or `/openapi.json` for the schema.

## Checks and build

```sh
npm run cf-typegen
npm run typecheck
npm test
npm run build
```

The build bundles the Worker into `dist/` without deploying it. Tests use local
Worker and D1 instances, not the production database.

## Deploy to Cloudflare

```sh
npx wrangler login
npx wrangler d1 create x-translator-server-db
```

Replace the all-zero `database_id` placeholder in `wrangler.jsonc` with the ID
returned by the create command. Keep the binding name `DB`.

```sh
npm run deploy
```

The `predeploy` script applies migrations to the configured **remote** D1 database
before deploying. Review migrations before deploying to an existing database.
No Cloudflare resources are created by local development or build commands.

Store future translation provider credentials using Cloudflare Secrets, not in
source code or `wrangler.jsonc`. Local secrets belong in the ignored `.dev.vars`
file. Never commit real credentials.

## Structure

- `src/index.ts`: Hono entry point and OpenAPI registration.
- `src/endpoints/`: template example endpoints, to be adapted for translation.
- `migrations/`: D1 schema migrations.
- `tests/`: Worker integration tests and local migration setup.
- `wrangler.jsonc`: Worker name and D1 binding configuration.

This directory belongs to the parent Git repository; it is not a separate Git
repository. No production deployment has been performed during initialization.
