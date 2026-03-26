import base64
import json
import os
import time
from typing import Any

import requests
import runpod

AIVIS_ENGINE_URL = os.environ.get("AIVIS_ENGINE_URL", "http://127.0.0.1:10101").rstrip("/")
CHECK_RETRIES = int(os.environ.get("AIVIS_API_AVAILABLE_MAX_RETRIES", "1200"))
CHECK_INTERVAL_MS = int(os.environ.get("AIVIS_API_AVAILABLE_INTERVAL_MS", "500"))
REQUEST_TIMEOUT = float(os.environ.get("AIVIS_REQUEST_TIMEOUT", "120"))

# Aivis/VOICEVOX compatible AudioQuery keys that are safe to override from job input.
ALLOWED_QUERY_OVERRIDE_KEYS = {
  "speedScale",
  "pitchScale",
  "intonationScale",
  "volumeScale",
  "prePhonemeLength",
  "postPhonemeLength",
  "outputSamplingRate",
  "outputStereo",
  "kana",
}


def parse_job_input(raw_input: Any):
  if raw_input is None:
    return None, "Please provide input"

  job_input = raw_input
  if isinstance(raw_input, str):
    try:
      job_input = json.loads(raw_input)
    except json.JSONDecodeError:
      return None, "Invalid JSON format in input"

  if not isinstance(job_input, dict):
    return None, "Input must be an object"

  text = str(job_input.get("text", "")).strip()
  if not text:
    return None, "Missing required field: text"

  speaker = job_input.get("speaker", job_input.get("style_id"))
  if speaker is not None:
    try:
      speaker = int(speaker)
    except (TypeError, ValueError):
      return None, "speaker/style_id must be an integer"

  query_overrides = job_input.get("query", {})
  if query_overrides is None:
    query_overrides = {}
  if not isinstance(query_overrides, dict):
    return None, "query must be an object"

  enable_interrogative_upspeak = job_input.get("enable_interrogative_upspeak")
  if enable_interrogative_upspeak is not None and not isinstance(enable_interrogative_upspeak, bool):
    return None, "enable_interrogative_upspeak must be boolean"

  core_version = job_input.get("core_version")
  if core_version is not None:
    core_version = str(core_version)

  return {
    "text": text,
    "speaker": speaker,
    "query": query_overrides,
    "core_version": core_version,
    "enable_interrogative_upspeak": enable_interrogative_upspeak,
  }, None


def parse_error_message(response: requests.Response):
  try:
    payload = response.json()
    if isinstance(payload, dict):
      return payload.get("detail") or payload.get("error") or payload.get("message") or response.text
  except Exception:
    pass
  return response.text


def wait_for_engine_ready():
  for _ in range(CHECK_RETRIES):
    try:
      response = requests.get(f"{AIVIS_ENGINE_URL}/version", timeout=10)
      if response.status_code == 200:
        return True
    except requests.RequestException:
      pass
    time.sleep(CHECK_INTERVAL_MS / 1000)
  return False


def resolve_default_speaker():
  response = requests.get(f"{AIVIS_ENGINE_URL}/speakers", timeout=REQUEST_TIMEOUT)
  response.raise_for_status()
  speakers = response.json()
  if not isinstance(speakers, list):
    raise RuntimeError("Unexpected /speakers response format")

  for speaker in speakers:
    styles = speaker.get("styles") if isinstance(speaker, dict) else None
    if not isinstance(styles, list):
      continue
    for style in styles:
      style_id = style.get("id") if isinstance(style, dict) else None
      try:
        return int(style_id)
      except (TypeError, ValueError):
        continue

  raise RuntimeError(
    "No style ID found from /speakers. Put .aivmx model files under "
    "/home/user/.local/share/AivisSpeech-Engine-Dev/Models."
  )


def make_audio_query(text: str, speaker: int, core_version: str | None):
  params: dict[str, Any] = {"text": text, "speaker": speaker}
  if core_version:
    params["core_version"] = core_version

  response = requests.post(
    f"{AIVIS_ENGINE_URL}/audio_query",
    params=params,
    timeout=REQUEST_TIMEOUT,
  )
  if not response.ok:
    raise RuntimeError(f"/audio_query failed ({response.status_code}): {parse_error_message(response)}")
  return response.json()


def apply_query_overrides(audio_query: dict[str, Any], overrides: dict[str, Any]):
  for key, value in overrides.items():
    if key in ALLOWED_QUERY_OVERRIDE_KEYS:
      audio_query[key] = value
  return audio_query


def synthesize(audio_query: dict[str, Any], speaker: int, core_version: str | None, enable_interrogative_upspeak: bool | None):
  params: dict[str, Any] = {"speaker": speaker}
  if core_version:
    params["core_version"] = core_version
  if enable_interrogative_upspeak is not None:
    params["enable_interrogative_upspeak"] = str(enable_interrogative_upspeak).lower()

  response = requests.post(
    f"{AIVIS_ENGINE_URL}/synthesis",
    params=params,
    json=audio_query,
    timeout=REQUEST_TIMEOUT,
  )
  if not response.ok:
    raise RuntimeError(f"/synthesis failed ({response.status_code}): {parse_error_message(response)}")
  return response.content


def handler(job):
  job_input = job.get("input")
  validated, error = parse_job_input(job_input)
  if error:
    return {"error": error}

  if not wait_for_engine_ready():
    return {
      "error": f"AivisSpeech Engine is not reachable at {AIVIS_ENGINE_URL}. "
      "First boot can take several minutes while models are prepared."
    }

  try:
    speaker = validated["speaker"]
    if speaker is None:
      speaker = resolve_default_speaker()

    audio_query = make_audio_query(validated["text"], speaker, validated["core_version"])
    audio_query = apply_query_overrides(audio_query, validated["query"])

    wav_bytes = synthesize(
      audio_query,
      speaker,
      validated["core_version"],
      validated["enable_interrogative_upspeak"],
    )

    return {
      "speaker": speaker,
      "format": "wav",
      "audio": base64.b64encode(wav_bytes).decode("utf-8"),
      "bytes": len(wav_bytes),
    }
  except Exception as exc:
    return {"error": str(exc)}


runpod.serverless.start({"handler": handler})
