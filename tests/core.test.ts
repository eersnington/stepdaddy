import { expect, it, vi } from "vite-plus/test";
import {
  StepdaddyError,
  createStepdaddy,
  defineExternalCall,
  type WorkflowEventLike,
  type WorkflowStepContextLike,
} from "../src/index.ts";
import type { CallStore, InternalStepdaddyAdapter, StepdaddyAdapter } from "../src/core/types.ts";

function workflow(overrides?: Partial<WorkflowEventLike>): WorkflowEventLike {
  return {
    workflowName: "ChargeCustomerWorkflow",
    instanceId: "invoice-77",
    payload: {},
    timestamp: new Date("2026-06-10T00:00:00.000Z"),
    ...overrides,
  };
}

function step(name: string, count = 1, attempt = 1): WorkflowStepContextLike {
  return { step: { name, count }, attempt };
}

it("stores request metadata and a full committed result without storing raw request data", async () => {
  const { adapter, records } = capturingAdapter();
  const stepdaddy = createStepdaddy({ adapter });
  const execute = vi.fn(async () => ({
    id: "pi_123",
    object: "payment_intent" as const,
    status: "succeeded" as const,
  }));
  const call = defineExternalCall<
    { customerId: string; amount: number; currency: string },
    { id: string; object: "payment_intent"; status: "succeeded" }
  >({
    name: "stripe.payment_intent.create",
    recovery: "idempotent-call",
    execute,
    summary: ({ request, result }) => ({
      externalId: result.id,
      status: result.status,
      currency: request.currency,
    }),
  });

  await stepdaddy.call(call, {
    workflow: workflow(),
    step: step("charge customer"),
    key: "wf:invoice-77:charge-customer",
    request: { customerId: "cus_123", amount: 1200, currency: "usd" },
  });

  expect(execute).toHaveBeenCalledTimes(1);
  expect(records.get("request.json")).toMatchObject({
    schemaVersion: 1,
    callName: "stripe.payment_intent.create",
    workflow: { name: "ChargeCustomerWorkflow", instanceId: "invoice-77" },
    step: { name: "charge customer", count: 1 },
  });
  expect(records.get("request.json")?.keyHash).toMatch(/^sha256:/);
  expect(records.get("request.json")?.requestDigest).toMatch(/^sha256:/);
  expect(JSON.stringify(records.get("request.json"))).not.toContain("cus_123");
  expect(JSON.stringify(records.get("request.json"))).not.toContain("1200");
  expect(records.get("committed.json")).toMatchObject({
    schemaVersion: 1,
    status: "committed",
    attempt: 1,
    result: { id: "pi_123", object: "payment_intent", status: "succeeded" },
    summary: { externalId: "pi_123", status: "succeeded", currency: "usd" },
  });
});

it("returns a prior committed result across retry attempts without executing", async () => {
  const stepdaddy = createStepdaddy({ adapter: capturingAdapter().adapter });
  const execute = vi.fn(async () => ({ id: "pi_123" }));
  const call = defineExternalCall<{ amount: number }, { id: string }>({
    name: "stripe.payment_intent.create",
    recovery: "idempotent-call",
    execute,
  });

  const first = await stepdaddy.call(call, {
    workflow: workflow(),
    step: step("charge customer", 1, 1),
    key: "wf:invoice-77:charge-customer",
    request: { amount: 1200 },
  });
  const second = await stepdaddy.call(call, {
    workflow: workflow(),
    step: step("charge customer", 1, 2),
    key: "wf:invoice-77:charge-customer",
    request: { amount: 1200 },
  });

  expect(first).toEqual({ id: "pi_123" });
  expect(second).toEqual(first);
  expect(execute).toHaveBeenCalledTimes(1);
});

it("rejects the same key with a different request before executing provider code", async () => {
  const stepdaddy = createStepdaddy({ adapter: capturingAdapter().adapter });
  const execute = vi.fn(async () => ({ id: "pi_123" }));
  const call = defineExternalCall<{ amount: number }, { id: string }>({
    name: "stripe.payment_intent.create",
    recovery: "idempotent-call",
    execute,
  });

  await stepdaddy.call(call, {
    workflow: workflow(),
    step: step("charge customer"),
    key: "wf:invoice-77:charge-customer",
    request: { amount: 1200 },
  });

  await expect(
    stepdaddy.call(call, {
      workflow: workflow(),
      step: step("charge customer", 1, 2),
      key: "wf:invoice-77:charge-customer",
      request: { amount: 1300 },
    }),
  ).rejects.toMatchObject({
    code: "SIDE_EFFECT_CONFLICT",
    retryable: false,
  } satisfies Partial<StepdaddyError>);
  expect(execute).toHaveBeenCalledTimes(1);
});

it("fails closed after a started record without a committed result", async () => {
  const { adapter, records } = capturingAdapter();
  const stepdaddy = createStepdaddy({ adapter });
  const execute = vi.fn(async () => {
    throw new Error("provider timeout");
  });
  const call = defineExternalCall<{ amount: number }, { id: string }>({
    name: "github.issue.create",
    recovery: "fail-closed",
    execute,
  });

  await expect(
    stepdaddy.call(call, {
      workflow: workflow(),
      step: step("create issue", 1, 1),
      key: "issue-marker-1",
      request: { amount: 1200 },
    }),
  ).rejects.toThrow("provider timeout");

  await expect(
    stepdaddy.call(call, {
      workflow: workflow(),
      step: step("create issue", 1, 2),
      key: "issue-marker-1",
      request: { amount: 1200 },
    }),
  ).rejects.toMatchObject({ code: "SIDE_EFFECT_AMBIGUOUS" });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(records.get("request.json")).toMatchObject({ callName: "github.issue.create" });
  expect(records.get("001-started.json")).toMatchObject({ status: "started", attempt: 1 });
  expect(records.get("001-error.json")).toMatchObject({
    status: "error",
    attempt: 1,
    error: { name: "Error", message: "provider timeout" },
  });
  expect(records.has("committed.json")).toBe(false);
});

it("uses reconcile to convert started/error data into a reconciled committed record", async () => {
  const { adapter, records } = capturingAdapter();
  const stepdaddy = createStepdaddy({ adapter });
  const execute = vi.fn(async () => {
    throw new Error("network died after provider accepted request");
  });
  const reconcile = vi.fn(async () => ({
    status: "found" as const,
    result: { number: 42, url: "https://github.example/42" },
  }));
  const call = defineExternalCall<{ title: string }, { number: number; url: string }>({
    name: "github.issue.create",
    recovery: { reconcile },
    execute,
  });

  await expect(
    stepdaddy.call(call, {
      workflow: workflow(),
      step: step("create issue", 1, 1),
      key: "issue-marker-1",
      request: { title: "bug" },
    }),
  ).rejects.toThrow("network died");

  await expect(
    stepdaddy.call(call, {
      workflow: workflow(),
      step: step("create issue", 1, 2),
      key: "issue-marker-1",
      request: { title: "bug" },
    }),
  ).resolves.toEqual({ number: 42, url: "https://github.example/42" });
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(records.get("001-error.json")).toMatchObject({
    status: "error",
    attempt: 1,
    error: { name: "Error", message: "network died after provider accepted request" },
  });
  expect(records.get("committed.json")).toMatchObject({
    status: "reconciled",
    attempt: 2,
    result: { number: 42, url: "https://github.example/42" },
  });
});

function capturingAdapter(): {
  adapter: StepdaddyAdapter;
  records: Map<string, Record<string, unknown>>;
} {
  const files = new Map<string, Uint8Array>();
  const records = new Map<string, Record<string, unknown>>();
  let initialized = false;
  let commitNumber = 0;
  const store: CallStore = {
    kind: "capturing",
    async openRun(input) {
      if (!initialized) {
        for (const [path, bytes] of input.initFiles) {
          files.set(path, bytes);
        }
        initialized = true;
      }
      return {
        repo: input.repoName,
        branch: input.branch,
        async readHead() {
          return initialized ? String(commitNumber).padStart(40, "0") : undefined;
        },
        async readFile(path) {
          return files.get(path) ?? null;
        },
        async commitFiles(commit) {
          for (const [path, bytes] of commit.files) {
            files.set(path, bytes);
            records.set(path.split("/").at(-1)!, JSON.parse(new TextDecoder().decode(bytes)));
          }
          commitNumber += 1;
          return { commit: String(commitNumber).padStart(40, "0") };
        },
      };
    },
  };
  return {
    adapter: { kind: "memory", store } as InternalStepdaddyAdapter as StepdaddyAdapter,
    records,
  };
}
