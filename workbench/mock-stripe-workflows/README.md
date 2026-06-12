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

## Inspect A Run Repo

Export and clone the sandbox-local Git repo after a workflow run:

```sh
ARTIFACTS_SANDBOX_URL=https://<artifacts-sandbox-worker> \
ARTIFACTS_SANDBOX_API_TOKEN=<token> \
bun run export-repo -- <workflow-instance-id>
```

If you keep the token in a local file:

```sh
ARTIFACTS_SANDBOX_URL=https://<artifacts-sandbox-worker> \
ARTIFACTS_SANDBOX_API_TOKEN_FILE=/path/to/token-file \
bun run export-repo -- <workflow-instance-id>
```

Then inspect its Git history from the cloned repo directory:

```sh
cd output/<workflow-instance-id>/git-repo
git log --oneline --decorate --graph -20
```

To include the full commit descriptions:

```sh
git log --decorate --graph --format=fuller -20
```

For subject plus body only:

```sh
git log --decorate --graph --format='%h %d %s%n%b' -20
```
