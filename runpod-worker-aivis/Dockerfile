ARG AIVIS_BASE_TAG=nvidia-latest
FROM ghcr.io/aivis-project/aivisspeech-engine:${AIVIS_BASE_TAG}

ARG PREWARM_SYNTH=true

ENV PYTHONUNBUFFERED=1 \
    AIVIS_ENGINE_URL=http://127.0.0.1:10101 \
    AIVIS_PORT=10101 \
    AIVIS_MODEL_DIR=/home/user/.local/share/AivisSpeech-Engine-Dev/Models

WORKDIR /

RUN mkdir -p "${AIVIS_MODEL_DIR}"
COPY models/*.aivmx ${AIVIS_MODEL_DIR}/
RUN chown -R user:user /home/user/.local/share/AivisSpeech-Engine-Dev

COPY requirements.txt /tmp/requirements.txt
RUN /opt/python/bin/pip install --no-cache-dir -r /tmp/requirements.txt \
    && rm -f /tmp/requirements.txt

COPY prewarm.py /prewarm.py
RUN if [ "${PREWARM_SYNTH}" = "true" ]; then \
      set -eux; \
      cd /opt/aivisspeech-engine; \
      gosu user /opt/python/bin/poetry run python ./run.py --host 127.0.0.1 --port 10101 --load_all_models >/tmp/aivis-build.log 2>&1 & \
      engine_pid=$!; \
      gosu user /opt/python/bin/python -u /prewarm.py; \
      kill "${engine_pid}"; \
      wait "${engine_pid}" || true; \
    fi

COPY handler.py /handler.py
COPY start.sh /start.sh
RUN chmod +x /start.sh

CMD ["/start.sh"]
