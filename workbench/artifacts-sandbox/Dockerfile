# syntax=docker/dockerfile:1

FROM golang:1.24 AS artifact-fs-build

ARG ARTIFACT_FS_REPO=https://github.com/cloudflare/artifact-fs.git
ARG ARTIFACT_FS_REF=main

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src

RUN git init . \
  && git remote add origin "$ARTIFACT_FS_REPO" \
  && git fetch --depth 1 origin "$ARTIFACT_FS_REF" \
  && git checkout FETCH_HEAD

RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /artifact-fs ./cmd/artifact-fs

FROM docker.io/cloudflare/sandbox:0.8.1

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    fuse3 \
    git \
    openssh-client \
    python3 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=artifact-fs-build /artifact-fs /usr/local/bin/artifact-fs
COPY container/mount-artifact-fs-repo.sh /usr/local/bin/mount-artifact-fs-repo
COPY container/commit-files.sh /usr/local/bin/commit-files

RUN chmod +x /usr/local/bin/artifact-fs /usr/local/bin/mount-artifact-fs-repo /usr/local/bin/commit-files

ENV ARTIFACT_FS_ROOT=/tmp/artifact-fs
ENV MOUNT_ROOT=/workspace/mnt
ENV ARTIFACT_FS_MOUNT_METADATA_FILE=/workspace/.artifact-fs-mount
