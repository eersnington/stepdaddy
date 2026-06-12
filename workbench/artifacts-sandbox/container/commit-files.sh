#!/usr/bin/env bash
set -euo pipefail

MANIFEST=${1:?manifest path is required}

eval "$(python3 - <<'PY' "$MANIFEST"
import json, shlex, sys
manifest = json.load(open(sys.argv[1]))
for key in ["mountPath", "message"]:
    print(f"{key}={shlex.quote(str(manifest[key]))}")
PY
)"

parent=""
if git -C "$mountPath" rev-parse HEAD >/dev/null 2>&1; then
  parent=$(git -C "$mountPath" rev-parse HEAD)
fi

python3 - <<'PY' "$MANIFEST" "$mountPath"
import json, pathlib, sys
manifest = json.load(open(sys.argv[1]))
root = pathlib.Path(sys.argv[2])
for entry in manifest["files"]:
    relative = pathlib.PurePosixPath(entry["path"])
    target = root.joinpath(*relative.parts)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(entry["content"])
PY

git -C "$mountPath" add -A
if git -C "$mountPath" diff --cached --quiet; then
  commit=$(git -C "$mountPath" rev-parse HEAD)
else
  git -C "$mountPath" -c user.name=artifactfs-sandbox -c user.email=artifactfs-sandbox@example.invalid commit -m "$message"
  commit=$(git -C "$mountPath" rev-parse HEAD)
  git -C "$mountPath" push
fi

python3 - <<'PY' "$commit" "$parent"
import json, sys
out = {"commit": sys.argv[1]}
if sys.argv[2]:
    out["parent"] = sys.argv[2]
print(json.dumps(out))
PY
