import copy
import json
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any

import requests
import websocket

COMFY_HOST = os.environ.get("COMFY_HOST", "127.0.0.1:8188")
COMFY_HTTP = f"http://{COMFY_HOST}"
CHECK_RETRIES = int(os.environ.get("COMFY_API_AVAILABLE_MAX_RETRIES", "600"))
CHECK_INTERVAL_MS = int(os.environ.get("COMFY_API_AVAILABLE_INTERVAL_MS", "500"))
WS_CONNECT_TIMEOUT = float(os.environ.get("COMFY_WS_CONNECT_TIMEOUT", "30"))
WS_RECV_TIMEOUT = float(os.environ.get("COMFY_WS_RECV_TIMEOUT", "60"))

WORKFLOW_PATH = os.environ.get("WAN_PREWARM_WORKFLOW_PATH", "/warmup-workflow.json")
NODE_MAP_PATH = os.environ.get("WAN_PREWARM_NODE_MAP_PATH", "/warmup-node-map.json")

# width x height x frames x steps x split_step x fps
DEFAULT_PREWARM_PROFILES = "832x576x63x4x2x10,576x832x63x4x2x10"

# 1x1 transparent PNG
WARMUP_IMAGE_BYTES = bytes.fromhex(
  "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489"
  "0000000A49444154789C6360000000020001E221BC330000000049454E44AE426082"
)


@dataclass
class WarmupProfile:
  width: int
  height: int
  num_frames: int
  steps: int
  split_step: int
  fps: int


def wait_for_server() -> bool:
  for _ in range(CHECK_RETRIES):
    try:
      response = requests.get(f"{COMFY_HTTP}/", timeout=5)
      if response.status_code == 200:
        return True
    except requests.RequestException:
      pass
    time.sleep(CHECK_INTERVAL_MS / 1000)
  return False


def load_json(path: str) -> dict[str, Any]:
  with open(path, "r", encoding="utf-8") as f:
    return json.load(f)


def set_node_value(workflow: dict[str, Any], node_map: dict[str, Any], key: str, value: Any) -> None:
  mapping = node_map.get(key)
  if mapping is None:
    return
  mappings = mapping if isinstance(mapping, list) else [mapping]
  for item in mappings:
    node_id = str(item["id"])
    input_name = str(item["input"])
    node = workflow.get(node_id)
    if not isinstance(node, dict):
      continue
    inputs = node.get("inputs")
    if not isinstance(inputs, dict):
      continue
    inputs[input_name] = value


def upload_warmup_image(filename: str) -> None:
  files = {
    "image": (filename, WARMUP_IMAGE_BYTES, "image/png"),
    "overwrite": (None, "true"),
  }
  response = requests.post(f"{COMFY_HTTP}/upload/image", files=files, timeout=30)
  response.raise_for_status()


def queue_workflow(workflow: dict[str, Any], client_id: str) -> str:
  payload = {"prompt": workflow, "client_id": client_id}
  response = requests.post(f"{COMFY_HTTP}/prompt", json=payload, timeout=30)
  response.raise_for_status()
  body = response.json()
  prompt_id = body.get("prompt_id")
  if not isinstance(prompt_id, str) or not prompt_id:
    raise RuntimeError(f"Missing prompt_id in /prompt response: {body}")
  return prompt_id


def wait_for_completion(prompt_id: str, client_id: str) -> None:
  ws = websocket.WebSocket()
  ws.connect(f"ws://{COMFY_HOST}/ws?clientId={client_id}", timeout=WS_CONNECT_TIMEOUT)
  ws.settimeout(WS_RECV_TIMEOUT)
  try:
    while True:
      try:
        message = ws.recv()
      except websocket.WebSocketTimeoutException:
        continue
      if not isinstance(message, str):
        continue
      data = json.loads(message)
      event_type = data.get("type")
      if event_type == "executing":
        payload = data.get("data", {})
        if payload.get("node") is None and payload.get("prompt_id") == prompt_id:
          return
      if event_type == "execution_error":
        payload = data.get("data", {})
        if payload.get("prompt_id") == prompt_id:
          raise RuntimeError(payload.get("exception_message") or "ComfyUI execution_error")
  finally:
    ws.close()


def parse_profiles(raw: str) -> list[WarmupProfile]:
  profiles: list[WarmupProfile] = []
  chunks = [item.strip() for item in raw.split(",") if item.strip()]
  for chunk in chunks:
    parts = [p for p in chunk.lower().split("x") if p]
    if len(parts) < 6:
      raise ValueError(
        f"Invalid profile '{chunk}'. Expected format: widthxheightxframesxstepsxsplit_stepxfps"
      )
    width, height, frames, steps, split_step, fps = [int(v) for v in parts[:6]]
    profiles.append(
      WarmupProfile(
        width=width,
        height=height,
        num_frames=frames,
        steps=steps,
        split_step=split_step,
        fps=fps,
      )
    )
  return profiles


def run_single_warmup(
  workflow_template: dict[str, Any],
  node_map: dict[str, Any],
  profile: WarmupProfile,
  index: int,
) -> str:
  workflow = copy.deepcopy(workflow_template)

  image_name = f"warmup_input_{index}.png"
  upload_warmup_image(image_name)

  set_node_value(workflow, node_map, "image", image_name)
  set_node_value(workflow, node_map, "prompt", "warmup, simple portrait")
  set_node_value(workflow, node_map, "negative_prompt", "low quality, artifacts, blurry")
  set_node_value(workflow, node_map, "seed", 1 + index)
  set_node_value(workflow, node_map, "steps", profile.steps)
  set_node_value(workflow, node_map, "cfg", 1)
  set_node_value(workflow, node_map, "width", profile.width)
  set_node_value(workflow, node_map, "height", profile.height)
  set_node_value(workflow, node_map, "num_frames", profile.num_frames)
  set_node_value(workflow, node_map, "fps", profile.fps)
  set_node_value(workflow, node_map, "start_step", profile.split_step)
  set_node_value(workflow, node_map, "end_step", profile.split_step)

  client_id = str(uuid.uuid4())
  prompt_id = queue_workflow(workflow, client_id)
  wait_for_completion(prompt_id, client_id)
  return prompt_id


def main() -> None:
  if not wait_for_server():
    raise RuntimeError(f"ComfyUI not reachable at {COMFY_HTTP}")

  workflow_template = load_json(WORKFLOW_PATH)
  node_map = load_json(NODE_MAP_PATH)

  profiles_raw = os.environ.get("WAN_PREWARM_PROFILES", DEFAULT_PREWARM_PROFILES)
  profiles = parse_profiles(profiles_raw)

  for index, profile in enumerate(profiles):
    started_at = time.time()
    prompt_id = run_single_warmup(workflow_template, node_map, profile, index)
    elapsed = time.time() - started_at
    print(
      "WAN prewarm done.",
      f"profile={index}",
      f"prompt_id={prompt_id}",
      f"size={profile.width}x{profile.height}",
      f"frames={profile.num_frames}",
      f"steps={profile.steps}",
      f"elapsed={elapsed:.2f}s",
    )


if __name__ == "__main__":
  main()
