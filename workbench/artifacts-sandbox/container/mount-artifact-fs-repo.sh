#!/usr/bin/env bash
set -euo pipefail

: "${MOUNT_GIT_REMOTE:?MOUNT_GIT_REMOTE is required}"
: "${MOUNT_GIT_BRANCH:=main}"
: "${ARTIFACT_FS_ROOT:=/tmp/artifact-fs}"
: "${MOUNT_ROOT:=/workspace/mnt}"
: "${ARTIFACT_FS_MOUNT_METADATA_FILE:=/workspace/.artifact-fs-mount}"
: "${ARTIFACT_FS_DAEMON_LOG:=/tmp/artifact-fs-daemon.log}"
: "${ARTIFACT_FS_DAEMON_PID_FILE:=/tmp/artifact-fs-daemon.pid}"

configure_git_credentials() {
  if [ -z "${MOUNT_GIT_USERNAME:-}" ] && [ -z "${MOUNT_GIT_PASSWORD:-}" ]; then
    return 0
  fi

  if [ -z "${MOUNT_GIT_USERNAME:-}" ] || [ -z "${MOUNT_GIT_PASSWORD:-}" ]; then
    echo "artifact-fs: MOUNT_GIT_USERNAME and MOUNT_GIT_PASSWORD must be provided together" >&2
    exit 1
  fi

  local payload
  payload="username=${MOUNT_GIT_USERNAME}"$'\n'"password=${MOUNT_GIT_PASSWORD}"
  payload="${payload//\'/\'\\\'\'}"

  export GIT_TERMINAL_PROMPT=0
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0=credential.helper
  export GIT_CONFIG_VALUE_0="!f() { printf '%s\n' '${payload}'; }; f"
}

validate_branch() {
  local branch="$1"
  if [[ -z "$branch" || "$branch" == @ || "$branch" == -* || "$branch" == /* || "$branch" == */ || "$branch" == *. || "$branch" == *..* || "$branch" == *//* || "$branch" == *@{* || "$branch" =~ [[:space:]~^:\?\*\[\\] ]]; then
    echo "artifact-fs: MOUNT_GIT_BRANCH must be a valid Git branch name" >&2
    exit 1
  fi
}

infer_repo_name() {
  local remote="$1"
  remote="${remote%/}"
  remote="${remote%.git}"
  local name="${remote##*/}"
  if [ -z "$name" ] || [ "$name" = "$remote" ]; then
    name="${remote##*:}"
  fi
  if [ -z "$name" ] || [ "$name" = "$remote" ]; then
    echo "artifact-fs: could not infer repo name from remote" >&2
    exit 1
  fi
  printf '%s\n' "$name"
}

ensure_daemon() {
  if [ -f "$ARTIFACT_FS_DAEMON_PID_FILE" ]; then
    local existing_pid
    existing_pid=$(cat "$ARTIFACT_FS_DAEMON_PID_FILE" 2>/dev/null || true)
    if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
      return
    fi
    rm -f "$ARTIFACT_FS_DAEMON_PID_FILE"
  fi

  nohup artifact-fs daemon --root "$MOUNT_ROOT" >"$ARTIFACT_FS_DAEMON_LOG" 2>&1 </dev/null &
  echo "$!" >"$ARTIFACT_FS_DAEMON_PID_FILE"
}

wait_for_mount() {
  local mount_path="$1"
  for _ in $(seq 1 120); do
    if [ -e "$mount_path/.git" ] && git -C "$mount_path" rev-parse HEAD >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "artifact-fs: mount did not appear at ${mount_path}" >&2
  exit 1
}

if [ ! -e /dev/fuse ]; then
  echo "artifact-fs: /dev/fuse is not available in this sandbox" >&2
  exit 1
fi

validate_branch "$MOUNT_GIT_BRANCH"
configure_git_credentials

REPO_NAME=$(infer_repo_name "$MOUNT_GIT_REMOTE")
MOUNT_PATH="${MOUNT_ROOT}/${REPO_NAME}"

mkdir -p "$ARTIFACT_FS_ROOT" "$MOUNT_ROOT"

if ! artifact-fs status --name "$REPO_NAME" >/dev/null 2>&1; then
  artifact-fs add-repo \
    --name "$REPO_NAME" \
    --remote "$MOUNT_GIT_REMOTE" \
    --branch "$MOUNT_GIT_BRANCH" \
    --mount-root "$MOUNT_ROOT"
fi

cat >"$ARTIFACT_FS_MOUNT_METADATA_FILE" <<EOF
MOUNTED_REMOTE=$MOUNT_GIT_REMOTE
MOUNTED_BRANCH=$MOUNT_GIT_BRANCH
MOUNTED_REPO_NAME=$REPO_NAME
MOUNTED_MOUNT_PATH=$MOUNT_PATH
EOF

ensure_daemon
wait_for_mount "$MOUNT_PATH"

printf 'repo_name=%s\n' "$REPO_NAME"
printf 'mount_path=%s\n' "$MOUNT_PATH"
printf 'head=%s\n' "$(git -C "$MOUNT_PATH" rev-parse HEAD)"
