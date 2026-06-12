# artifacts-sandbox

Cloudflare Sandbox + FUSE workbench for ArtifactFS.

This mounts a sandbox-local Git repo through ArtifactFS by default. It can also mount an external Git remote when a caller or deployment config provides one.

This is not the Cloudflare Artifacts REST API. It is a deployable ArtifactFS/Sandbox workbench.

## Build

The Docker image is self-contained. It clones and builds `artifact-fs` from GitHub during the image build:

```text
ARTIFACT_FS_REPO=https://github.com/cloudflare/artifact-fs.git
ARTIFACT_FS_REF=main
```

## Configure

```sh
bun install
bunx wrangler secret put ARTIFACTS_SANDBOX_API_TOKEN
```

The branch defaults to `main`. Set `ARTIFACTFS_SANDBOX_ID` to choose the default sandbox instance; it defaults to `artifactfs-sandbox`.

Request bodies may provide a `remote` to mount an external Git repo. If configured Git credentials are present, request-selected remotes are rejected unless `ARTIFACTFS_ALLOW_REQUEST_REMOTE=true`.

## Storage Modes

Default mode is self-contained. `POST /mount` with an empty JSON body creates or reuses a bare Git repo inside the sandbox at `/workspace/repos/<repoName>.git`, then mounts it through ArtifactFS.

External remotes are optional. Pass `remote` when you want ArtifactFS to mount a GitHub repo, Cloudflare Artifacts Git remote, or another Git-over-HTTPS remote instead of the sandbox-local repo.

## API

All routes except `GET /` require `Authorization: Bearer <ARTIFACTS_SANDBOX_API_TOKEN>`.

```text
POST /mount
GET  /status?sandboxId=<id>
GET  /file?sandboxId=<id>&path=<repo-path>
POST /commit
GET  /bundle?sandboxId=<id>
```

Mount the default sandbox-local repo:

```sh
curl -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -X POST "$SANDBOX_URL/mount" \
  --data '{}'
```

Mount an external remote:

```sh
curl -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -X POST "$SANDBOX_URL/mount" \
  --data '{"remote":"https://github.com/cloudflare/artifact-fs.git","branch":"main"}'
```

`POST /commit` is a workbench convenience. It accepts text files only:

```json
{
  "sandboxId": "artifactfs-sandbox",
  "message": "Update files",
  "files": [{ "path": "notes/example.json", "content": "{\"ok\":true}\n" }]
}
```

```sh
curl -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -X POST "$SANDBOX_URL/commit" \
  --data '{"message":"Update notes","files":[{"path":"notes/example.txt","content":"hello\n"}]}'

curl -H "Authorization: Bearer $TOKEN" \
  "$SANDBOX_URL/file?path=notes/example.txt"
```

## Git History Export

`GET /bundle` creates a Git bundle from the mounted repo and returns its base64 text so you can clone it locally and inspect commit history.

The `mock-stripe-workflows` workbench includes `bun run export-repo -- <workflow-instance-id>` for this.

## Deploy

```sh
bun run deploy
```
