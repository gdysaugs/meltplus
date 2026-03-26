# RunPod worker: AivisSpeech Engine

This image runs AivisSpeech Engine and a RunPod serverless handler in one
container.
AIVMX models in `models/` are baked into the image so the worker does not need
to fetch them at startup.

## Files

- `handler.py`: RunPod job handler (`text` -> base64 WAV)
- `start.sh`: starts Aivis engine, then starts RunPod handler
- `Dockerfile`: image definition
- `models/*.aivmx`: baked voice models
- `prewarm.py`: build-time warmup (`/audio_query` + `/synthesis`)

## Build

CPU build:

```bash
docker build --build-arg AIVIS_BASE_TAG=cpu-latest -t aivis-runpod:cpu .
```

GPU build:

```bash
docker build --build-arg AIVIS_BASE_TAG=nvidia-latest -t aivis-runpod:gpu .
```

Optional build args:

- `PREWARM_SYNTH` (`true`/`false`, default: `true`)

## Local run

```bash
docker run --rm -it \
  -e RUNPOD_API_KEY=your_runpod_api_key \
  -e AIVIS_USE_GPU=true \
  --gpus all \
  aivis-runpod:gpu
```

Optional env vars:

- `AIVIS_USE_GPU` (`true`/`false`, default: `true`)
- `AIVIS_LOAD_ALL_MODELS` (`true`/`false`, default: `false`)
- `AIVIS_HOST` (default: `0.0.0.0`)
- `AIVIS_PORT` (default: `10101`)
- `AIVIS_ENGINE_URL` (default: `http://127.0.0.1:10101`)
- `AIVIS_REQUEST_TIMEOUT` (seconds, default: `120`)
- `AIVIS_API_AVAILABLE_MAX_RETRIES` (default: `1200`)
- `AIVIS_API_AVAILABLE_INTERVAL_MS` (default: `500`)

Notes:

- `PREWARM_SYNTH=true` performs one synthesis during image build to prime model
  and NLP caches so first runtime request is faster and avoids first-request
  downloads as much as possible.

## RunPod job input example

```json
{
  "input": {
    "text": "Hello from MeltPlus.",
    "speaker": 888753760,
    "query": {
      "speedScale": 1.0,
      "pitchScale": 0.0
    }
  }
}
```

Response:

```json
{
  "speaker": 888753760,
  "format": "wav",
  "audio": "<base64 wav>",
  "bytes": 123456
}
```
