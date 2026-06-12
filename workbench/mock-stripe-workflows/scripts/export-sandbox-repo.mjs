import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const exec = promisify(execFile);

const instanceId = process.argv[2];
if (!instanceId) throw new Error("usage: bun run export-repo -- <workflow-instance-id>");

const sandboxUrl = requiredEnv("ARTIFACTS_SANDBOX_URL").replace(/\/+$/, "");
const token =
  process.env.ARTIFACTS_SANDBOX_API_TOKEN ??
  (await readFile(requiredEnv("ARTIFACTS_SANDBOX_API_TOKEN_FILE"), "utf8")).trim();

const outputDir = join(process.cwd(), "output", instanceId);
const bundlePath = join(outputDir, "artifactfs-sandbox.bundle");
const clonePath = join(outputDir, "git-repo");

await mkdir(outputDir, { recursive: true });

const response = await fetch(`${sandboxUrl}/bundle`, {
  headers: { authorization: `Bearer ${token}` },
});

if (!response.ok) {
  throw new Error(`GET /bundle failed with HTTP ${response.status}: ${await response.text()}`);
}

await writeFile(bundlePath, Buffer.from((await response.text()).replace(/\s/g, ""), "base64"));

await exec("git", ["bundle", "verify", bundlePath]);
await rm(clonePath, { recursive: true, force: true });
await exec("git", ["clone", bundlePath, clonePath]);

console.log(`cloned sandbox repo to ${clonePath}`);
console.log(`cd ${clonePath}`);
console.log("git log --decorate --graph --format=fuller -20");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
