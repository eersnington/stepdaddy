import { getSandbox, Sandbox } from "@cloudflare/sandbox";

export class ArtifactsSandbox extends Sandbox {}

type Env = {
  readonly ARTIFACTS_SANDBOX: DurableObjectNamespace<ArtifactsSandbox>;
  readonly ARTIFACTS_SANDBOX_API_TOKEN?: string;
  readonly ARTIFACTFS_BACKING_GIT_REMOTE?: string;
  readonly ARTIFACTFS_BACKING_GIT_BRANCH?: string;
  readonly ARTIFACTFS_SANDBOX_ID?: string;
  readonly ARTIFACTFS_ALLOW_REQUEST_REMOTE?: string;
  readonly ARTIFACTFS_GIT_USERNAME?: string;
  readonly ARTIFACTFS_GIT_PASSWORD?: string;
};

const DEFAULT_BRANCH = "main";
const DEFAULT_SANDBOX_ID = "artifactfs-sandbox";
const MOUNT_SCRIPT = "/usr/local/bin/mount-artifact-fs-repo";
const COMMIT_SCRIPT = "/usr/local/bin/commit-files";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        return new Response(helpText(), {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      authorize(request, env);

      if (request.method === "POST" && url.pathname === "/mount") return mount(request, env);
      if (request.method === "GET" && url.pathname === "/status") return status(request, env);
      if (request.method === "GET" && url.pathname === "/file") return file(request, env);
      if (request.method === "POST" && url.pathname === "/commit") return commit(request, env);

      return Response.json({ error: "not found" }, { status: 404 });
    } catch (error) {
      return errorResponse(error);
    }
  },
} satisfies ExportedHandler<Env>;

async function mount(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const config = mountConfig(env, body);
  const sandbox = getSandbox(env.ARTIFACTS_SANDBOX, config.sandboxId, {
    normalizeId: true,
    sleepAfter: "15m",
  });
  const result = await sandbox.exec(MOUNT_SCRIPT, {
    cwd: "/workspace",
    timeout: 120_000,
    env: config.env,
  });
  if (!result.success) return commandError("ArtifactFS mount failed", result);

  const output = parseKeyValue(result.stdout);
  const repoName = output.get("repo_name");
  const mountPath = output.get("mount_path");
  if (repoName === undefined || repoName === "") throw new UserError("missing repo_name", 500);
  if (mountPath === undefined || mountPath === "") throw new UserError("missing mount_path", 500);
  return Response.json({
    sandboxId: config.sandboxId,
    remote: config.remote ?? null,
    branch: config.branch,
    repoName,
    mountPath,
    head: output.get("head") ?? null,
  });
}

async function status(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sandboxId = (
    url.searchParams.get("sandboxId") ??
    env.ARTIFACTFS_SANDBOX_ID ??
    DEFAULT_SANDBOX_ID
  )
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(sandboxId))
    throw new UserError("sandboxId is invalid", 400);
  const sandbox = getSandbox(env.ARTIFACTS_SANDBOX, sandboxId, {
    normalizeId: true,
    sleepAfter: "15m",
  });
  const metadata = await sandbox.readFile("/workspace/.artifact-fs-mount").catch(() => null);
  if (metadata === null) return Response.json({ error: "no mounted repo" }, { status: 404 });

  const mount = parseKeyValue(metadata.content);
  const mountPath = mount.get("MOUNTED_MOUNT_PATH");
  const repoName = mount.get("MOUNTED_REPO_NAME");
  if (mountPath === undefined || mountPath === "")
    throw new UserError("missing MOUNTED_MOUNT_PATH", 500);
  if (repoName === undefined || repoName === "")
    throw new UserError("missing MOUNTED_REPO_NAME", 500);
  const artifactFs = await sandbox.exec(`artifact-fs status --name ${shellQuote(repoName)}`);
  const gitHead = await sandbox.exec(`git -C ${shellQuote(mountPath)} rev-parse HEAD`);
  const gitStatus = await sandbox.exec(`git -C ${shellQuote(mountPath)} status --short --branch`);

  return Response.json({
    sandboxId,
    remote: mount.get("MOUNTED_REMOTE"),
    branch: mount.get("MOUNTED_BRANCH"),
    repoName,
    mountPath,
    artifactFsStatus: artifactFs.stdout.trim(),
    head: gitHead.stdout.trim() || null,
    gitStatus: gitStatus.stdout.trim() || null,
  });
}

async function file(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sandboxId = (
    url.searchParams.get("sandboxId") ??
    env.ARTIFACTFS_SANDBOX_ID ??
    DEFAULT_SANDBOX_ID
  )
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(sandboxId))
    throw new UserError("sandboxId is invalid", 400);
  const path = cleanRepoPath(url.searchParams.get("path") ?? "");
  const sandbox = getSandbox(env.ARTIFACTS_SANDBOX, sandboxId, {
    normalizeId: true,
    sleepAfter: "15m",
  });
  const mountPath = await mountedPath(sandbox);

  try {
    const result = await sandbox.readFile(`${mountPath}/${path}`);
    return new Response(result.content, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}

async function commit(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) throw new UserError("request body must be JSON", 400);
  if (typeof body.message !== "string" || body.message === "")
    throw new UserError("message is required", 400);
  if (!Array.isArray(body.files)) throw new UserError("files must be an array", 400);

  const files = body.files.map((entry) => {
    const file = entry as { path?: unknown; content?: unknown };
    if (typeof file.path !== "string") throw new UserError("file path must be a string", 400);
    if (typeof file.content !== "string") throw new UserError("file content must be a string", 400);
    return { path: cleanRepoPath(file.path), content: file.content };
  });

  const sandboxId = (
    typeof body.sandboxId === "string"
      ? body.sandboxId
      : (env.ARTIFACTFS_SANDBOX_ID ?? DEFAULT_SANDBOX_ID)
  )
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(sandboxId))
    throw new UserError("sandboxId is invalid", 400);
  const sandbox = getSandbox(env.ARTIFACTS_SANDBOX, sandboxId, {
    normalizeId: true,
    sleepAfter: "15m",
  });
  const mountPath = await mountedPath(sandbox);
  const manifest = `/tmp/artifacts-commit-${crypto.randomUUID()}.json`;
  await sandbox.writeFile(manifest, JSON.stringify({ mountPath, message: body.message, files }));
  const result = await sandbox.exec(`${COMMIT_SCRIPT} ${shellQuote(manifest)}`, {
    timeout: 120_000,
  });
  if (!result.success) return commandError("commit failed", result);
  return Response.json(JSON.parse(result.stdout));
}

function mountConfig(env: Env, body: Record<string, unknown>) {
  const requestedRemote =
    typeof body.remote === "string" && body.remote !== "" ? body.remote : undefined;
  if (
    requestedRemote !== undefined &&
    env.ARTIFACTFS_GIT_PASSWORD !== undefined &&
    env.ARTIFACTFS_GIT_PASSWORD !== "" &&
    env.ARTIFACTFS_ALLOW_REQUEST_REMOTE !== "true"
  ) {
    throw new UserError(
      "request remote is disabled while configured Git credentials are present; use the configured backing remote or set ARTIFACTFS_ALLOW_REQUEST_REMOTE=true",
      400,
    );
  }
  const remote = requestedRemote ?? env.ARTIFACTFS_BACKING_GIT_REMOTE;
  const branch =
    typeof body.branch === "string" && body.branch !== ""
      ? body.branch
      : (env.ARTIFACTFS_BACKING_GIT_BRANCH ?? DEFAULT_BRANCH);
  const sandboxId = (
    typeof body.sandboxId === "string"
      ? body.sandboxId
      : (env.ARTIFACTFS_SANDBOX_ID ?? DEFAULT_SANDBOX_ID)
  )
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(sandboxId))
    throw new UserError("sandboxId is invalid", 400);
  const repoName = (typeof body.repoName === "string" ? body.repoName : sandboxId)
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(repoName))
    throw new UserError("repoName is invalid", 400);
  const username =
    typeof body.gitUsername === "string" ? body.gitUsername : env.ARTIFACTFS_GIT_USERNAME;
  const password =
    typeof body.gitPassword === "string" ? body.gitPassword : env.ARTIFACTFS_GIT_PASSWORD;

  return {
    remote,
    branch,
    sandboxId,
    env: {
      MOUNT_GIT_BRANCH: branch,
      MOUNT_REPO_NAME: repoName,
      ...(remote === undefined ? {} : { MOUNT_GIT_REMOTE: remote }),
      ...(remote !== undefined && username !== undefined ? { MOUNT_GIT_USERNAME: username } : {}),
      ...(remote !== undefined && password !== undefined ? { MOUNT_GIT_PASSWORD: password } : {}),
    },
  };
}

async function mountedPath(sandbox: ReturnType<typeof getSandbox>): Promise<string> {
  const metadata = await sandbox.readFile("/workspace/.artifact-fs-mount").catch(() => null);
  if (metadata === null) throw new UserError("no mounted repo", 404);
  const mountPath = parseKeyValue(metadata.content).get("MOUNTED_MOUNT_PATH");
  if (mountPath === undefined || mountPath === "")
    throw new UserError("missing MOUNTED_MOUNT_PATH", 500);
  return mountPath;
}

function authorize(request: Request, env: Env): void {
  const expected = env.ARTIFACTS_SANDBOX_API_TOKEN;
  if (expected === undefined || expected === "")
    throw new UserError("ARTIFACTS_SANDBOX_API_TOKEN is not configured", 500);
  if (request.headers.get("authorization") !== `Bearer ${expected}`)
    throw new UserError("Unauthorized", 401);
}

function cleanRepoPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("/")) throw new UserError("path must be repo-relative", 400);
  const path = trimmed.replace(/\/+$/, "");
  if (path === "") throw new UserError("path is required", 400);
  const parts = path.split("/");
  if (
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        part === ".git" ||
        part === ".artifact-fs-mount",
    )
  )
    throw new UserError("path must be repo-relative", 400);
  return path;
}

function parseKeyValue(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.trim().split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1));
  }
  return values;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function commandError(
  message: string,
  result: { stdout: string; stderr: string; exitCode?: number },
): Response {
  return Response.json(
    { error: message, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
    { status: 500 },
  );
}

function errorResponse(error: unknown): Response {
  if (error instanceof UserError)
    return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof Response) return error;
  return Response.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}

function helpText(): string {
  return [
    "ArtifactFS Sandbox workbench",
    "",
    "POST /mount",
    "GET  /status?sandboxId=<id>",
    "GET  /file?sandboxId=<id>&path=<repo-path>",
    "POST /commit",
    "",
  ].join("\n");
}

class UserError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
