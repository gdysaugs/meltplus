FROM suarez123/wan22-i2v:v2026.03.17-190559-18899

ENV WAN_PREWARM=true \
    WAN_PREWARM_WORKFLOW_PATH=/warmup-workflow.json \
    WAN_PREWARM_NODE_MAP_PATH=/warmup-node-map.json \
    WAN_PREWARM_WIDTH=512 \
    WAN_PREWARM_HEIGHT=512 \
    WAN_PREWARM_FRAMES=17 \
    WAN_PREWARM_STEPS=4 \
    WAN_PREWARM_SPLIT_STEP=2 \
    WAN_PREWARM_FPS=10

COPY warmup-workflow.json /warmup-workflow.json
COPY warmup-node-map.json /warmup-node-map.json
COPY prewarm.py /prewarm.py
COPY start.sh /start.sh

RUN chmod +x /start.sh

CMD ["/start.sh"]
