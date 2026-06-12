const workflowUrl = requiredEnv("WORKFLOW_URL").replace(/\/+$/, "");

const started = await fetch(`${workflowUrl}/charge`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    customerId: "cus_mock_workbench",
    amount: 1200,
    currency: "usd",
  }),
});

if (!started.ok)
  throw new Error(`POST /charge failed with HTTP ${started.status}: ${await started.text()}`);

const startBody = await started.json();
const id = startBody.id;
if (typeof id !== "string" || id === "")
  throw new Error("workflow start response did not include id");

const successStates = new Set(["complete", "completed", "success", "succeeded"]);
const failureStates = new Set([
  "errored",
  "error",
  "failed",
  "terminated",
  "canceled",
  "cancelled",
]);

let lastStatus = startBody.status;
for (let attempt = 0; attempt < 60; attempt += 1) {
  const response = await fetch(`${workflowUrl}/status/${encodeURIComponent(id)}`);
  if (!response.ok)
    throw new Error(
      `GET /status/${id} failed with HTTP ${response.status}: ${await response.text()}`,
    );
  const body = await response.json();
  lastStatus = body.status;
  const state = statusState(lastStatus);
  console.log(`workflow ${id}: ${state ?? "unknown"}`);
  if (state !== undefined && successStates.has(state)) {
    console.log(JSON.stringify({ id, status: lastStatus }, null, 2));
    process.exit(0);
  }
  if (state !== undefined && failureStates.has(state)) {
    throw new Error(
      `workflow ${id} ended in failure state ${state}: ${JSON.stringify(lastStatus)}`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

throw new Error(`workflow ${id} did not complete before timeout: ${JSON.stringify(lastStatus)}`);

function statusState(status) {
  if (typeof status === "string") return status;
  if (status && typeof status.status === "string") return status.status;
  if (status && typeof status.state === "string") return status.state;
  return undefined;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
