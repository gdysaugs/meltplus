FROM suarez123/wan22-i2v:v2026.03.17-190559-18899

ENV WAN_PREWARM=true \
    WAN_PREWARM_WORKFLOW_PATH=/warmup-workflow.json \
    WAN_PREWARM_NODE_MAP_PATH=/warmup-node-map.json \
    WAN_PREWARM_PROFILES=832x576x63x4x2x10,576x832x63x4x2x10 \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
    CUDA_MODULE_LOADING=LAZY

COPY warmup-workflow.json /warmup-workflow.json
COPY warmup-node-map.json /warmup-node-map.json
COPY prewarm.py /prewarm.py
COPY start.sh /start.sh

RUN chmod +x /start.sh

CMD ["/start.sh"]
