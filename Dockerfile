FROM python:3.12-slim-bookworm

LABEL org.opencontainers.image.title="Anti-Matter" \
      org.opencontainers.image.description="Local pairing-code vault and offline QR scanner" \
      org.opencontainers.image.source="https://github.com/tempeduck/Anti-Matter-HA" \
      org.opencontainers.image.licenses="MIT"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    STORAGE_DIR=/config \
    ANTIMATTER_DATA=/config \
    ANTIMATTER_OPTIONS=/config/options.json \
    ANTIMATTER_MEDIA=/config/media \
    ANTIMATTER_PORT=8099

# Scalable fonts keep generated labels readable, including their setup codes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 antimatter \
    && useradd --uid 1000 --gid antimatter --no-create-home --shell /usr/sbin/nologin antimatter \
    && mkdir -p /config/media \
    && chown -R antimatter:antimatter /config

WORKDIR /app
COPY anti_matter/app/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY anti_matter/app/ ./
COPY LICENSE /usr/share/licenses/anti-matter/LICENSE

USER antimatter
EXPOSE 8099
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('ANTIMATTER_PORT', '8099') + '/api/info', timeout=3).read()"]
CMD ["python", "main.py"]
