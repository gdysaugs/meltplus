#!/usr/bin/env bash
set -euo pipefail

COMFY_ARGS=${COMFY_ARGS:---disable-auto-launch --disable-metadata --log-stdout --highvram}

echo "worker-comfyui: Starting ComfyUI with args: ${COMFY_ARGS}"
python -u /comfyui/main.py ${COMFY_ARGS} &

if [ "${WAN_PREWARM:-true}" = "true" ]; then
  echo "worker-comfyui: Running warmup profiles: ${WAN_PREWARM_PROFILES:-}"
  if python -u /prewarm.py; then
    echo "worker-comfyui: Warmup completed"
  else
    echo "worker-comfyui: Warmup failed (continuing)"
  fi
fi

echo "worker-comfyui: Starting RunPod handler"
python -u /handler.py
