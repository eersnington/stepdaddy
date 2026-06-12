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

## API

All routes except `GET /` require `Authorization: Bearer <ARTIFACTS_SANDBOX_API_TOKEN>`.

```text
POST /mount
GET  /status?sandboxId=<id>
GET  /file?sandboxId=<id>&path=<repo-path>
POST /commit
```

`POST /commit` is a workbench convenience. It accepts text files only:

```json
{
  "sandboxId": "artifactfs-sandbox",
  "message": "Update files",
  "files": [{ "path": "notes/example.json", "content": "{\"ok\":true}\n" }]
}
```

## Deploy

```sh
bun run deploy
```
