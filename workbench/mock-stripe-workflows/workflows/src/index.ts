import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createStepdaddy, defineExternalCall } from "stepdaddy";

type ChargePayload = {
  readonly customerId: string;
  readonly amount: number;
  readonly currency: string;
};

type StripeIntentInput = {
  readonly customerId: string;
  readonly amount: number;
  readonly currency: string;
};

type StripeInvoiceInput = {
  readonly customerId: string;
  readonly paymentIntentId: string;
};

type StripePaymentIntent = {
  readonly id: string;
  readonly object: "payment_intent";
  readonly status?: string;
};

type StripeInvoice = {
  readonly id: string;
  readonly object: "invoice";
  readonly status?: string;
  readonly hosted_invoice_url?: string;
};

type Env = {
  readonly CHARGE_CUSTOMER_WORKFLOW: Workflow<ChargePayload>;
  readonly ARTIFACTS_SANDBOX_URL: string;
  readonly ARTIFACTS_SANDBOX_API_TOKEN: string;
  readonly ARTIFACTS_SANDBOX_ID?: string;
  readonly STRIPE_BASE_URL: string;
  readonly STRIPE_SECRET: string;
};

const DEFAULT_SANDBOX_ID = "artifactfs-sandbox";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ChargeCustomerWorkflow extends WorkflowEntrypoint<Env, ChargePayload> {
  async run(event: WorkflowEvent<ChargePayload>, step: WorkflowStep) {
    const stepdaddy = createStepdaddy({
      adapter: artifactfsSandboxAdapter({
        url: this.env.ARTIFACTS_SANDBOX_URL,
        token: this.env.ARTIFACTS_SANDBOX_API_TOKEN,
        sandboxId: this.env.ARTIFACTS_SANDBOX_ID ?? DEFAULT_SANDBOX_ID,
      }),
    });
    const stripeBaseUrl = this.env.STRIPE_BASE_URL.replace(/\/+$/, "");

    const createPaymentIntent = defineExternalCall<StripeIntentInput, StripePaymentIntent>({
      name: "stripe.payment_intent.create",
      recovery: "idempotent-call",
      execute: async ({ request, key }) => {
        const response = await fetch(`${stripeBaseUrl}/v1/payment_intents`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.env.STRIPE_SECRET}`,
            "content-type": "application/x-www-form-urlencoded",
            "idempotency-key": key,
          },
          body: new URLSearchParams({
            customer: request.customerId,
            amount: String(request.amount),
            currency: request.currency,
          }),
        });
        const body = (await response.json()) as StripePaymentIntent;
        if (!response.ok)
          throw new Error(`Stripe payment_intent.create failed with HTTP ${response.status}`);
        return body;
      },
      summary: ({ request, result }) => ({
        externalId: result.id,
        status: result.status,
        amount: request.amount,
        currency: request.currency,
      }),
    });

    const createInvoice = defineExternalCall<StripeInvoiceInput, StripeInvoice>({
      name: "stripe.invoice.create",
      recovery: "idempotent-call",
      execute: async ({ request, key }) => {
        const response = await fetch(`${stripeBaseUrl}/v1/invoices`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.env.STRIPE_SECRET}`,
            "content-type": "application/x-www-form-urlencoded",
            "idempotency-key": key,
          },
          body: new URLSearchParams({
            customer: request.customerId,
            metadata_payment_intent: request.paymentIntentId,
          }),
        });
        const body = (await response.json()) as StripeInvoice;
        if (!response.ok)
          throw new Error(`Stripe invoice.create failed with HTTP ${response.status}`);
        return body;
      },
      summary: ({ request, result }) => ({
        externalId: result.id,
        status: result.status,
        paymentIntentId: request.paymentIntentId,
      }),
    });

    const charge = await step.do("charge customer", async (ctx) => {
      const intent = await stepdaddy.call(createPaymentIntent, {
        workflow: event,
        step: ctx,
        key: `wf:${event.instanceId}:charge-customer`,
        request: {
          customerId: event.payload.customerId,
          amount: event.payload.amount,
          currency: event.payload.currency,
        },
      });
      return { paymentIntentId: intent.id };
    });

    const invoice = await step.do("create invoice", async (ctx) => {
      const created = await stepdaddy.call(createInvoice, {
        workflow: event,
        step: ctx,
        key: `wf:${event.instanceId}:create-invoice`,
        request: {
          customerId: event.payload.customerId,
          paymentIntentId: charge.paymentIntentId,
        },
      });
      return { invoiceId: created.id };
    });

    return { paymentIntentId: charge.paymentIntentId, invoiceId: invoice.invoiceId };
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/charge") {
        const payload = await parseChargePayload(request);
        const instance = await env.CHARGE_CUSTOMER_WORKFLOW.create({ params: payload });
        return Response.json({ id: instance.id, status: await instance.status() });
      }

      if (request.method === "GET" && url.pathname.startsWith("/status/")) {
        const id = url.pathname.slice("/status/".length);
        const instance = await env.CHARGE_CUSTOMER_WORKFLOW.get(id);
        return Response.json({ id, status: await instance.status() });
      }

      return new Response("POST /charge to start, GET /status/:id to inspect.\n", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    } catch (error) {
      if (error instanceof Response) return error;
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;

type OpenRunInput = {
  readonly repoName: string;
  readonly branch: string;
  readonly initFiles: ReadonlyMap<string, Uint8Array>;
  readonly initMessage: string;
};

type CommitFilesInput = {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly message: string;
};

type ArtifactfsSandboxAdapterOptions = {
  readonly url: string;
  readonly token: string;
  readonly sandboxId: string;
};

type CommitResult = {
  readonly commit: string;
  readonly parent?: string;
};

function artifactfsSandboxAdapter(
  options: ArtifactfsSandboxAdapterOptions,
): Parameters<typeof createStepdaddy>[0]["adapter"] {
  const baseUrl = options.url.replace(/\/+$/, "");

  const send = async (method: "GET" | "POST", route: string, body?: unknown): Promise<Response> => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(
        `Could not reach artifacts sandbox at ${baseUrl} (${method} ${route}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return response;
  };

  const readJson = async <T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> => {
    const response = await send(method, route, body);
    await assertSandboxOk(response, `${method} ${route}`);
    return (await response.json()) as T;
  };

  return {
    kind: "artifactfs-sandbox",
    store: {
      kind: "artifactfs-sandbox",
      async openRun(input: OpenRunInput) {
        await readJson("POST", "/mount", {
          sandboxId: options.sandboxId,
          branch: input.branch,
        });
        await readJson("POST", "/commit", {
          sandboxId: options.sandboxId,
          message: input.initMessage,
          files: sandboxFiles(input.repoName, input.initFiles),
        });

        return {
          repo: input.repoName,
          branch: input.branch,
          async readHead(): Promise<string | undefined> {
            const status = await readJson<{ readonly head?: string | null }>(
              "GET",
              `/status?sandboxId=${encodeURIComponent(options.sandboxId)}`,
            );
            return typeof status.head === "string" ? status.head : undefined;
          },
          async readFile(path: string): Promise<Uint8Array | null> {
            const response = await send(
              "GET",
              `/file?sandboxId=${encodeURIComponent(options.sandboxId)}&path=${encodeURIComponent(sandboxPath(input.repoName, path))}`,
            );
            if (response.status === 404) return null;
            await assertSandboxOk(response, `GET /file ${path}`);
            return encoder.encode(await response.text());
          },
          async commitFiles(commit: CommitFilesInput): Promise<CommitResult> {
            return await readJson<CommitResult>("POST", "/commit", {
              sandboxId: options.sandboxId,
              message: commit.message,
              files: sandboxFiles(input.repoName, commit.files),
            });
          },
        };
      },
    },
  } as Parameters<typeof createStepdaddy>[0]["adapter"];
}

async function assertSandboxOk(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => "");
  throw new Error(
    `Artifacts sandbox rejected ${operation} with HTTP ${response.status}` +
      (text === "" ? "." : `: ${text.slice(0, 500)}`),
  );
}

function sandboxFiles(repoName: string, files: ReadonlyMap<string, Uint8Array>) {
  return [...files].map(([path, bytes]) => ({
    path: sandboxPath(repoName, path),
    content: decoder.decode(bytes),
  }));
}

function sandboxPath(repoName: string, path: string): string {
  return `runs/${repoName}/${path}`;
}

async function parseChargePayload(request: Request): Promise<ChargePayload> {
  const body = await request.json().catch(() => null);
  if (body === null || typeof body !== "object") {
    throw new Response("request body must be JSON\n", { status: 400 });
  }
  const payload = body as Record<string, unknown>;
  if (typeof payload.customerId !== "string" || payload.customerId.trim() === "") {
    throw new Response("customerId must be a non-empty string\n", { status: 400 });
  }
  if (
    typeof payload.amount !== "number" ||
    !Number.isInteger(payload.amount) ||
    payload.amount <= 0
  ) {
    throw new Response("amount must be a positive integer\n", { status: 400 });
  }
  if (typeof payload.currency !== "string" || !/^[a-z]{3}$/.test(payload.currency)) {
    throw new Response("currency must be a lowercase 3-letter ISO currency code\n", {
      status: 400,
    });
  }
  return {
    customerId: payload.customerId,
    amount: payload.amount,
    currency: payload.currency,
  };
}
