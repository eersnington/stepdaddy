export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/payment_intents") {
      return Response.json({
        id: "pi_mock",
        object: "payment_intent",
        status: "succeeded",
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/invoices") {
      return Response.json({
        id: "in_mock",
        object: "invoice",
        status: "open",
        hosted_invoice_url: "https://example.invalid/invoices/in_mock",
      });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
} satisfies ExportedHandler;
