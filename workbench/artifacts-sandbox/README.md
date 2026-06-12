# artifacts-sandbox

Cloudflare Sandbox + FUSE workbench for ArtifactFS.

This follows the upstream `cloudflare/artifact-fs/examples/cloudflare-sandbox-sdk` shape: mount one Git remote into a Cloudflare Sandbox, inspect status, read text files, and optionally commit text files back to the mounted repo.

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
bunx wrangler secret put ARTIFACTFS_BACKING_GIT_REMOTE
bunx wrangler secret put ARTIFACTFS_GIT_PASSWORD
```

Set `ARTIFACTFS_GIT_USERNAME` if the backing remote needs a username. The branch defaults to `main`.

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
