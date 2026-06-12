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

type SandboxHandle = ReturnType<typeof getSandbox>;

type MountInfo = {
  readonly repoName: string;
  readonly mountPath: string;
  readonly remote?: string;
  readonly branch?: string;
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
        return new Response(
          [
            "ArtifactFS Sandbox workbench",
            "",
            "POST /mount",
            "GET  /status?sandboxId=<id>",
            "GET  /file?sandboxId=<id>&path=<repo-path>",
            "POST /commit",
            "GET  /bundle?sandboxId=<id>",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/plain; charset=utf-8" } },
        );
      }

      authorize(request, env);

      if (request.method === "POST" && url.pathname === "/mount") return await mount(request, env);
      if (request.method === "GET" && url.pathname === "/status") return await status(request, env);
      if (request.method === "GET" && url.pathname === "/file") return await file(request, env);
      if (request.method === "POST" && url.pathname === "/commit")
        return await commit(request, env);
      if (request.method === "GET" && url.pathname === "/bundle") return await bundle(request, env);

      return Response.json({ error: "not found" }, { status: 404 });
    } catch (error) {
      if (error instanceof UserError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<Env>;

async function mount(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const config = mountConfig(env, body);
  const result = await getSandbox(env.ARTIFACTS_SANDBOX, config.sandboxId, {
    normalizeId: true,
    sleepAfter: "15m",
  }).exec(MOUNT_SCRIPT, {
    cwd: "/workspace",
    timeout: 120_000,
    env: config.env,
  });
  if (!result.success) {
    return Response.json(
      {
        error: "ArtifactFS mount failed",
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
      { status: 500 },
    );
  }

  const output = parseKeyValue(result.stdout);
  const repoName = output.get("repo_name");
  const mountPath = output.get("mount_path");
  if (!repoName) throw new UserError("mount script did not report repo_name", 500);
  if (!mountPath) throw new UserError("mount script did not report mount_path", 500);

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
  const sandboxId = sandboxIdFrom(new URL(request.url).searchParams.get("sandboxId"), env);
  const instance = getSandbox(env.ARTIFACTS_SANDBOX, sandboxId, {
    normalizeId: true,
    sleepAfter: "15m",
  });
  const mount = await readMount(instance);

  const artifactFs = await instance.exec(`artifact-fs status --name ${shellQuote(mount.repoName)}`);
  const gitHead = await instance.exec(`git -C ${shellQuote(mount.mountPath)} rev-parse HEAD`);
  const gitStatus = await instance.exec(
    `git -C ${shellQuote(mount.mountPath)} status --short --branch`,
  );

  return Response.json({
    sandboxId,
    remote: mount.remote,
    branch: mount.branch,
    repoName: mount.repoName,
    mountPath: mount.mountPath,
    artifactFsStatus: artifactFs.stdout.trim(),
    head: gitHead.stdout.trim() || null,
    gitStatus: gitStatus.stdout.trim() || null,
  });
}

async function file(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const instance = getSandbox(
    env.ARTIFACTS_SANDBOX,
    sandboxIdFrom(url.searchParams.get("sandboxId"), env),
    {
      normalizeId: true,
      sleepAfter: "15m",
    },
  );
  const mount = await readMount(instance);
  const path = repoPathFrom(url.searchParams.get("path") ?? "");

  try {
    const result = await instance.readFile(`${mount.mountPath}/${path}`);
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
  if (typeof body.message !== "string" || body.message === "") {
    throw new UserError("message is required", 400);
  }
  if (!Array.isArray(body.files)) throw new UserError("files must be an array", 400);

  const files = body.files.map((entry) => {
    const file = entry as { path?: unknown; content?: unknown };
    if (typeof file.path !== "string") throw new UserError("file path must be a string", 400);
    if (typeof file.content !== "string") {
      throw new UserError("file content must be a string", 400);
    }
    return { path: repoPathFrom(file.path), content: file.content };
  });

  const instance = getSandbox(
    env.ARTIFACTS_SANDBOX,
    sandboxIdFrom(typeof body.sandboxId === "string" ? body.sandboxId : null, env),
    {
      normalizeId: true,
      sleepAfter: "15m",
    },
  );
  const mount = await readMount(instance);
  const manifest = `/tmp/artifacts-commit-${crypto.randomUUID()}.json`;
  await instance.writeFile(
    manifest,
    JSON.stringify({ mountPath: mount.mountPath, message: body.message, files }),
  );

  const result = await instance.exec(`${COMMIT_SCRIPT} ${shellQuote(manifest)}`, {
    timeout: 120_000,
  });
  if (!result.success) {
    return Response.json(
      {
        error: "commit failed",
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
      { status: 500 },
    );
  }
  return Response.json(JSON.parse(result.stdout));
}

async function bundle(request: Request, env: Env): Promise<Response> {
  const instance = getSandbox(
    env.ARTIFACTS_SANDBOX,
    sandboxIdFrom(new URL(request.url).searchParams.get("sandboxId"), env),
    {
      normalizeId: true,
      sleepAfter: "15m",
    },
  );
  const mount = await readMount(instance);
  const bundlePath = `/tmp/artifactfs-${crypto.randomUUID()}.bundle`;
  const result = await instance.exec(
    `git -C ${shellQuote(mount.mountPath)} bundle create ${shellQuote(bundlePath)} --all && base64 -w 0 ${shellQuote(bundlePath)}`,
    { timeout: 120_000 },
  );
  if (!result.success) {
    return Response.json(
      {
        error: "bundle failed",
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
      { status: 500 },
    );
  }

  return new Response(result.stdout, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${mount.repoName}.bundle.base64"`,
    },
  });
}

function mountConfig(env: Env, body: Record<string, unknown>) {
  const remote =
    typeof body.remote === "string" && body.remote !== ""
      ? body.remote
      : env.ARTIFACTFS_BACKING_GIT_REMOTE;
  if (
    typeof body.remote === "string" &&
    body.remote !== "" &&
    env.ARTIFACTFS_GIT_PASSWORD &&
    env.ARTIFACTFS_ALLOW_REQUEST_REMOTE !== "true"
  ) {
    throw new UserError(
      "request remote is disabled while configured Git credentials are present; use the configured backing remote or set ARTIFACTFS_ALLOW_REQUEST_REMOTE=true",
      400,
    );
  }

  const branch =
    typeof body.branch === "string" && body.branch !== ""
      ? body.branch
      : (env.ARTIFACTFS_BACKING_GIT_BRANCH ?? DEFAULT_BRANCH);
  const sandboxId = sandboxIdFrom(typeof body.sandboxId === "string" ? body.sandboxId : null, env);
  const repoName = (typeof body.repoName === "string" ? body.repoName : sandboxId)
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(repoName)) {
    throw new UserError("repoName is invalid", 400);
  }

  const gitUsername =
    remote && typeof body.gitUsername === "string" ? body.gitUsername : env.ARTIFACTFS_GIT_USERNAME;
  const gitPassword =
    remote && typeof body.gitPassword === "string" ? body.gitPassword : env.ARTIFACTFS_GIT_PASSWORD;

  return {
    remote,
    branch,
    sandboxId,
    env: {
      MOUNT_GIT_BRANCH: branch,
      MOUNT_REPO_NAME: repoName,
      ...(remote ? { MOUNT_GIT_REMOTE: remote } : {}),
      ...(gitUsername ? { MOUNT_GIT_USERNAME: gitUsername } : {}),
      ...(gitPassword ? { MOUNT_GIT_PASSWORD: gitPassword } : {}),
    },
  };
}

function sandboxIdFrom(value: string | null | undefined, env: Env): string {
  const sandboxId = (value ?? env.ARTIFACTFS_SANDBOX_ID ?? DEFAULT_SANDBOX_ID).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(sandboxId)) {
    throw new UserError("sandboxId is invalid", 400);
  }
  return sandboxId;
}

async function readMount(sandbox: SandboxHandle): Promise<MountInfo> {
  const metadata = await sandbox.readFile("/workspace/.artifact-fs-mount").catch(() => null);
  if (metadata === null) throw new UserError("no mounted repo", 404);

  const values = parseKeyValue(metadata.content);
  const repoName = values.get("MOUNTED_REPO_NAME");
  const mountPath = values.get("MOUNTED_MOUNT_PATH");
  const remote = values.get("MOUNTED_REMOTE");
  const branch = values.get("MOUNTED_BRANCH");
  if (!repoName) throw new UserError("mount metadata is missing MOUNTED_REPO_NAME", 500);
  if (!mountPath) throw new UserError("mount metadata is missing MOUNTED_MOUNT_PATH", 500);

  return {
    repoName,
    mountPath,
    ...(remote ? { remote } : {}),
    ...(branch ? { branch } : {}),
  };
}

function repoPathFrom(value: string): string {
  const path = value.trim().replace(/\/+$/, "");
  if (path === "" || path.startsWith("/")) throw new UserError("path must be repo-relative", 400);
  if (
    path.split("/").some((part) => ["", ".", "..", ".git", ".artifact-fs-mount"].includes(part))
  ) {
    throw new UserError("path must be repo-relative", 400);
  }
  return path;
}

function authorize(request: Request, env: Env): void {
  const token = env.ARTIFACTS_SANDBOX_API_TOKEN;
  if (!token) throw new UserError("ARTIFACTS_SANDBOX_API_TOKEN is not configured", 500);
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    throw new UserError("Unauthorized", 401);
  }
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

class UserError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
