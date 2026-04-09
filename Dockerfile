FROM node:20-alpine AS frontend-build

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --silent

COPY frontend/public ./public
COPY frontend/src ./src

RUN npm run build


FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r ./requirements.txt

COPY backend ./backend
COPY --from=frontend-build /app/frontend/build ./frontend/build

RUN useradd -m appuser && chown -R appuser:appuser /app

USER appuser

EXPOSE 8765

CMD ["uvicorn", "backend.foundry_agent_server:app", "--host", "0.0.0.0", "--port", "8765"]
