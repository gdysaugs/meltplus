import json
import time
import urllib.parse
import urllib.request

BASE_URL = "http://127.0.0.1:10101"
READY_RETRIES = 1200
READY_INTERVAL_SECONDS = 0.5


def get_json(path: str):
    with urllib.request.urlopen(f"{BASE_URL}{path}", timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_until_ready():
    for _ in range(READY_RETRIES):
        try:
            get_json("/version")
            return
        except Exception:
            time.sleep(READY_INTERVAL_SECONDS)
    raise RuntimeError("Aivis engine did not become ready in time during image build")


def resolve_style_id():
    speakers = get_json("/speakers")
    if not isinstance(speakers, list):
        raise RuntimeError("Unexpected /speakers response format")

    for speaker in speakers:
        if not isinstance(speaker, dict):
            continue
        styles = speaker.get("styles", [])
        if not isinstance(styles, list):
            continue
        for style in styles:
            if not isinstance(style, dict):
                continue
            style_id = style.get("id")
            if isinstance(style_id, int):
                return style_id
    raise RuntimeError("No style id found from /speakers during image prewarm")


def run_warmup(style_id: int):
    params = urllib.parse.urlencode({"text": "cache warmup", "speaker": style_id})
    query_req = urllib.request.Request(f"{BASE_URL}/audio_query?{params}", method="POST")
    with urllib.request.urlopen(query_req, timeout=120) as response:
        audio_query = json.loads(response.read().decode("utf-8"))

    payload = json.dumps(audio_query).encode("utf-8")
    synth_req = urllib.request.Request(
        f"{BASE_URL}/synthesis?speaker={style_id}",
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(synth_req, timeout=180) as response:
        wav_bytes = response.read()

    if not wav_bytes.startswith(b"RIFF"):
        raise RuntimeError("Warmup synthesis did not return a WAV payload")


def main():
    wait_until_ready()
    style_id = resolve_style_id()
    run_warmup(style_id)
    print(f"Aivis warmup completed with style_id={style_id}.")


if __name__ == "__main__":
    main()
