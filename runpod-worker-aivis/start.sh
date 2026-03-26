#!/usr/bin/env bash
set -euo pipefail

AIVIS_HOST="${AIVIS_HOST:-0.0.0.0}"
AIVIS_PORT="${AIVIS_PORT:-10101}"
AIVIS_USE_GPU="${AIVIS_USE_GPU:-true}"
AIVIS_LOAD_ALL_MODELS="${AIVIS_LOAD_ALL_MODELS:-false}"

ENGINE_ARGS=(--host "${AIVIS_HOST}" --port "${AIVIS_PORT}")
if [ "${AIVIS_USE_GPU}" = "true" ]; then
  ENGINE_ARGS+=(--use_gpu)
fi
if [ "${AIVIS_LOAD_ALL_MODELS}" = "true" ]; then
  ENGINE_ARGS+=(--load_all_models)
fi

echo "worker-aivis: Starting AivisSpeech Engine (${AIVIS_HOST}:${AIVIS_PORT})"
cd /opt/aivisspeech-engine
gosu user /opt/python/bin/poetry run python ./run.py "${ENGINE_ARGS[@]}" &

echo "worker-aivis: Starting RunPod handler"
exec gosu user /opt/python/bin/python -u /handler.py
