# mock-stripe-workflows

Mocked Stripe + Cloudflare Workflows bench for Stepdaddy.

The Workflow Worker uses a local workbench adapter that stores Stepdaddy records in `../artifacts-sandbox` through its generic `/mount`, `/file`, and `/commit` API.

## Deploy Stripe Mock

```sh
bun install
bun run deploy:stripe-mock
```

## Deploy Workflow Worker

```sh
bunx wrangler secret put ARTIFACTS_SANDBOX_URL --config workflows/wrangler.jsonc
bunx wrangler secret put ARTIFACTS_SANDBOX_API_TOKEN --config workflows/wrangler.jsonc
bunx wrangler secret put STRIPE_BASE_URL --config workflows/wrangler.jsonc
bunx wrangler secret put STRIPE_SECRET --config workflows/wrangler.jsonc
bun run deploy:workflows
```

Set these vars in `workflows/wrangler.jsonc` or through Wrangler before deploying:

```text
ARTIFACTS_SANDBOX_URL
ARTIFACTS_SANDBOX_API_TOKEN
ARTIFACTS_SANDBOX_ID
STRIPE_BASE_URL
STRIPE_SECRET
```

## Smoke

```sh
WORKFLOW_URL=https://<workflow-worker> bun run smoke
```
