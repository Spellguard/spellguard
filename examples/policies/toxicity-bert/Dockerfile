FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TOKENIZERS_PARALLELISM=false \
    PORT=3100

WORKDIR /app

COPY requirements.txt .
# Install everything (incl. torch) from PyPI so pip resolves the correct
# platform wheel — manylinux x86_64 on Intel/CI, manylinux aarch64 on Apple
# Silicon. The previous --index-url whl/cpu pin only served x86_64 reliably
# and produced an unimportable torch under arm64, crashing the pipeline import.
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 3100

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3100"]
