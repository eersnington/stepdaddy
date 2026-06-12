# Stepdaddy Workbench

Deployable benches for exercising Stepdaddy outside the published library package.

## Benches

`artifacts-sandbox` deploys a Cloudflare Sandbox container with FUSE and `artifact-fs`. It mounts a Git remote, exposes status/file inspection, and has a small text-file commit helper.

`mock-stripe-workflows` deploys a mocked Stripe Worker and a Cloudflare Workflows Worker that records calls in `artifacts-sandbox` through a local workbench adapter.

## Order

1. Deploy `artifacts-sandbox`.
2. Deploy `mock-stripe-workflows/stripe-mock`.
3. Deploy `mock-stripe-workflows/workflows` with the sandbox and Stripe URLs configured.

## Validate

```sh
cd workbench/artifacts-sandbox && bun run typecheck
cd workbench/mock-stripe-workflows && bun run typecheck
```

These benches are not published with the package. The root package publishes only `dist`.
