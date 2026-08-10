#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CONTRACT="${ROOT}/scripts/visual-contract.json"
ARTIFACTS="${ROOT}/.artifacts"
STAGE="${ARTIFACTS}/visual-capture"
WORK="${STAGE}/work"
IMAGE="$(
  node -e '
    const fs = require("fs");
    const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (typeof contract.containerImage !== "string") process.exit(1);
    process.stdout.write(contract.containerImage);
  ' "${CONTRACT}"
)"

cleanup() {
  rm -rf -- "${STAGE}"
}
if [[ -e "${ARTIFACTS}" ]]; then
  if [[ ! -d "${ARTIFACTS}" || -L "${ARTIFACTS}" ]]; then
    echo ".artifacts must be a real directory" >&2
    exit 1
  fi
else
  mkdir -m 0700 -- "${ARTIFACTS}"
fi
trap cleanup EXIT
cleanup
mkdir -p "${WORK}"

INPUT_LINES="$(
  node -e '
    const fs = require("fs");
    const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (
      !Array.isArray(contract.staticInputs) ||
      contract.staticInputs.some((value) => typeof value !== "string")
    ) {
      process.exit(1);
    }
    process.stdout.write(contract.staticInputs.join("\n"));
  ' "${CONTRACT}"
)"
mapfile -t INPUTS <<<"${INPUT_LINES}"

while IFS= read -r -d "" test_file; do
  INPUTS+=("${test_file#"${ROOT}/"}")
done < <(
  find "${ROOT}/test" -maxdepth 1 -type f -name "*.test.js" \
    -print0 | sort -z
)

for relative_path in "${INPUTS[@]}"; do
  source_path="${ROOT}/${relative_path}"
  if [[ ! -f "${source_path}" || -L "${source_path}" ]]; then
    echo "unsafe or missing visual input: ${relative_path}" >&2
    exit 1
  fi
  mkdir -p "$(dirname "${WORK}/${relative_path}")"
  cp -- "${source_path}" "${WORK}/${relative_path}"
done

# Dependency preparation is separate from evidence capture. npm verifies every
# downloaded package against package-lock.json, and lifecycle scripts stay off.
docker run --rm --network bridge --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 256 \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp \
  --env npm_config_cache=/tmp/npm-cache \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m \
  --volume "${WORK}:/work" \
  --workdir /work \
  "${IMAGE}" \
  npm ci --ignore-scripts --no-audit --no-fund

# The capture sees only an isolated, disposable copy of hash-bound inputs.
# Private IPC, a loopback-only network namespace, and a read-only container
# root prevent it from reaching the host repository or network.
docker run --rm --network none --read-only \
  --shm-size 1g \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 512 \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp \
  --env PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  --volume "${WORK}:/work" \
  --workdir /work \
  "${IMAGE}" \
  bash -ceu 'node scripts/capture-visuals.mjs && node scripts/verify-evidence.mjs'

node "${ROOT}/scripts/promote-visuals.mjs" "${WORK}"
