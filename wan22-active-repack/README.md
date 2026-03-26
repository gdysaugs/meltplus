# wan22-active-repack

Derived image for active-worker usage, based on:

- `suarez123/wan22-i2v:v2026.03.17-190559-18899`

What this image adds:

- Startup warmup job (ComfyUI i2v workflow) before handler starts
- Keeps base image untouched; this is a separate tag

## Build

```bash
cd /home/adama/plus/wan22-active-repack
docker build -t suarez123/wan22-i2v:v2026.03.25-active-prewarm .
```

## Push

```bash
docker push suarez123/wan22-i2v:v2026.03.25-active-prewarm
```

## Runtime env (optional)

- `WAN_PREWARM=true|false` (default: `true`)
- `WAN_PREWARM_WIDTH` (default: `512`)
- `WAN_PREWARM_HEIGHT` (default: `512`)
- `WAN_PREWARM_FRAMES` (default: `17`)
- `WAN_PREWARM_STEPS` (default: `4`)
- `WAN_PREWARM_SPLIT_STEP` (default: `2`)
- `WAN_PREWARM_FPS` (default: `10`)
