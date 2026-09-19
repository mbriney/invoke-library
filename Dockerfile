FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV INVOKE_OUTPUTS_DIR=/data/invoke-outputs \
    KEEP_DIR=/data/keepers \
    CONFIG_DIR=/data/config \
    PORT=8080 \
    PYTHONUNBUFFERED=1

RUN mkdir -p /data/invoke-outputs /data/keepers /data/config

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/health" || exit 1

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
