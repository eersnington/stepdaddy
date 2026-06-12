import { DurableObject } from "cloudflare:workers";

type Env = {
  readonly STRIPE_IDEMPOTENCY: DurableObjectNamespace<StripeIdempotency>;
};

type StoredResponse = {
  readonly signature: string;
  readonly response: Record<string, unknown>;
  readonly requestCount: number;
};

export class StripeIdempotency extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    if (!key) return Response.json({ error: "idempotency key is required" }, { status: 400 });

    const body = (await request.json()) as {
      readonly signature?: unknown;
      readonly response?: unknown;
    };
    if (typeof body.signature !== "string" || typeof body.response !== "object") {
      return Response.json({ error: "signature and response are required" }, { status: 400 });
    }

    const existing = await this.ctx.storage.get<StoredResponse>(key);
    if (existing) {
      if (existing.signature !== body.signature) {
        return Response.json(
          {
            error: {
              type: "idempotency_error",
              message: "Keys for idempotent requests can only be reused with the same request.",
            },
          },
          { status: 409 },
        );
      }

      const requestCount = existing.requestCount + 1;
      await this.ctx.storage.put(key, { ...existing, requestCount });
      return Response.json({
        ...existing.response,
        mockIdempotency: { replayed: true, requestCount },
      });
    }

    await this.ctx.storage.put(key, {
      signature: body.signature,
      response: body.response as Record<string, unknown>,
      requestCount: 1,
    });
    return Response.json({
      ...(body.response as Record<string, unknown>),
      mockIdempotency: { replayed: false, requestCount: 1 },
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/payment_intents") {
      return await idempotentResponse(request, env, {
        id: "pi_mock",
        object: "payment_intent",
        status: "succeeded",
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/invoices") {
      return await idempotentResponse(request, env, {
        id: "in_mock",
        object: "invoice",
        status: "open",
        hosted_invoice_url: "https://example.invalid/invoices/in_mock",
      });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function idempotentResponse(
  request: Request,
  env: Env,
  response: Record<string, unknown>,
): Promise<Response> {
  const key = request.headers.get("idempotency-key");
  if (!key) return Response.json({ error: "idempotency-key header is required" }, { status: 400 });

  const form = await request.formData();
  const signature = `${new URL(request.url).pathname}:${[...form]
    .map(([name, value]) => `${name}=${typeof value === "string" ? value : value.name}`)
    .sort()
    .join("&")}`;
  const id = env.STRIPE_IDEMPOTENCY.idFromName(key);
  return await env.STRIPE_IDEMPOTENCY.get(id).fetch(
    `https://stripe-idempotency.local/?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      body: JSON.stringify({ signature, response }),
    },
  );
}
