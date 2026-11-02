#!/usr/bin/env bash
# Trusted worker entry point. Called by the server, never exposed as a model shell tool.
set -euo pipefail
shift # discard host Java executable; the container supplies Java 25
java_args=("$@")
bob_path=''
for ((i=0; i<${#java_args[@]}-1; i++)); do
  if [[ "${java_args[$i]}" == '-jar' ]]; then bob_path="${java_args[$((i+1))]}"; break; fi
done
[[ -n "$bob_path" && -f "$bob_path" && "$(basename "$PWD")" == 'source' ]] || exit 64
project_root="$(dirname "$PWD")"
engine_root="$(dirname "$bob_path")"
exec docker run --rm --init --pull=never --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --memory 1g --cpus 2 --pids-limit 128 \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$project_root,dst=$project_root" \
  --mount "type=bind,src=$engine_root,dst=$engine_root,readonly" \
  --tmpfs /tmp:rw,nosuid,size=64m --workdir "$PWD" \
  "${QINGJIAN_DEFOLD_WORKER_IMAGE:-qingjian-defold-worker:1.14.0}" \
  java "${java_args[@]}"
