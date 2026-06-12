import { expect, it } from "vite-plus/test";
import { createStepdaddy, defineExternalCall } from "../src/index.ts";
import { remote } from "../src/remote.ts";

type MultipartMetadata = {
  readonly files: Array<{ readonly path: string; readonly part: string }>;
  readonly [key: string]: unknown;
};

it("remote HTTP adapter sends multipart metadata with raw call-history record parts", async () => {
  const requests: Array<{
    readonly method: string;
    readonly path: string;
    readonly authorization: string | null;
    readonly body: FormData | undefined;
    readonly metadata: MultipartMetadata | undefined;
  }> = [];
  const files = new Map<string, Uint8Array>();
  let head = "0".repeat(40);
  const fakeFetch: typeof fetch = async (input, init) => {
    const inputUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(inputUrl);
    const body = init?.body instanceof FormData ? init.body : undefined;
    const metadataPart = body?.get("metadata");
    const metadata =
      metadataPart instanceof Blob
        ? (JSON.parse(await metadataPart.text()) as MultipartMetadata)
        : undefined;

    requests.push({
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      authorization: new Headers(init?.headers).get("authorization"),
      body,
      metadata,
    });

    if (metadata !== undefined) {
      for (const { path, part } of metadata.files) {
        const file = body?.get(part);
        if (!(file instanceof Blob)) throw new Error(`missing ${part} part`);
        files.set(path, new Uint8Array(await file.arrayBuffer()));
      }
    }

    if (url.pathname === "/runs/open") {
      return new Response(JSON.stringify({ repo: "repo", branch: "main", head }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname.endsWith("/head")) {
      return new Response(JSON.stringify({ head }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname.endsWith("/file")) {
      const path = url.searchParams.get("path") ?? "";
      const bytes = files.get(path);
      return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes);
    }
    if (url.pathname.endsWith("/commit")) {
      const parent = head;
      head = head === "0".repeat(40) ? "1".repeat(40) : "2".repeat(40);
      return new Response(JSON.stringify({ commit: head, parent }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unexpected route", { status: 500 });
  };
  const stepdaddy = createStepdaddy({
    adapter: remote({
      url: "https://remote.example",
      token: "secret-token",
      fetch: fakeFetch,
    }),
  });
  const call = defineExternalCall<{ amount: number }, { id: string }>({
    name: "stripe.payment_intent.create",
    recovery: "idempotent-call",
    execute: async () => ({ id: "pi_123" }),
  });

  const result = await stepdaddy.call(call, {
    workflow: { workflowName: "BinaryWorkflow", instanceId: "binary-1" },
    step: { step: { name: "charge customer", count: 1 }, attempt: 1 },
    key: "wf:binary-1:charge-customer",
    request: { amount: 1200 },
  });

  expect(result).toEqual({ id: "pi_123" });
  const openRequest = requests.find((request) => request.path === "/runs/open");
  expect(openRequest?.authorization).toBe("Bearer secret-token");
  expect(openRequest?.metadata).toMatchObject({ protocolVersion: 1, branch: "main" });
  expect(openRequest?.metadata?.files).toEqual([{ path: ".stepd/run.json", part: "file-0" }]);

  const commitRequests = requests.filter((request) => request.path.endsWith("/commit"));
  expect(commitRequests).toHaveLength(2);
  expect(JSON.stringify(commitRequests[0]?.metadata)).not.toContain("pi_123");
  const committedEntry = commitRequests[1]?.metadata?.files.find((entry) =>
    entry.path.endsWith("/committed.json"),
  );
  expect(committedEntry).toBeDefined();
  const committedPart = commitRequests[1]?.body?.get(committedEntry!.part);
  expect(committedPart).toBeInstanceOf(Blob);
  await expect((committedPart as Blob).text()).resolves.toContain("pi_123");
});
