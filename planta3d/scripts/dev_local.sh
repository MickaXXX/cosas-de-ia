#!/usr/bin/env bash
# Arranque local SIN Docker (Linux/WSL2): PostgreSQL y Redis locales, API y trabajador.
# Uso: scripts/dev_local.sh up|down|status
# Variables: P3D_PGDATA (directorio de datos PostgreSQL), P3D_LOGS (logs). Solo escucha en 127.0.0.1.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACK="$ROOT/backend"
PGDATA="${P3D_PGDATA:-$HOME/.planta3d/pgdata}"
LOGS="${P3D_LOGS:-$HOME/.planta3d/logs}"
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
mkdir -p "$LOGS"
as_pg() { if [ "$(id -u)" = 0 ]; then su postgres -c "$*"; else bash -c "$*"; fi; }

up() {
  if [ ! -d "$PGDATA/base" ]; then
    mkdir -p "$PGDATA"; [ "$(id -u)" = 0 ] && chown postgres "$PGDATA"
    as_pg "$PGBIN/initdb -D $PGDATA -A trust -U postgres >/dev/null"
    FRESH=1
  fi
  as_pg "$PGBIN/pg_ctl -D $PGDATA -l $PGDATA/server.log -o '-c listen_addresses=127.0.0.1 -p 5432' status >/dev/null" \
    || as_pg "$PGBIN/pg_ctl -D $PGDATA -l $PGDATA/server.log -o '-c listen_addresses=127.0.0.1 -p 5432' -w start >/dev/null"
  if [ "${FRESH:-0}" = 1 ]; then
    psql -h 127.0.0.1 -U postgres -qc "create user planta3d password 'planta3d_dev'"
    psql -h 127.0.0.1 -U postgres -qc "create database planta3d owner planta3d"
    psql -h 127.0.0.1 -U postgres -qc "create database planta3d_test owner planta3d"
  fi
  redis-cli -h 127.0.0.1 ping >/dev/null 2>&1 || redis-server --bind 127.0.0.1 --port 6379 --daemonize yes >/dev/null
  cd "$BACK"
  .venv/bin/alembic upgrade head
  pgrep -f "uvicorn app.main:app" >/dev/null || setsid nohup .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 > "$LOGS/api.log" 2>&1 &
  pgrep -f "celery -A app.worker.celery_app" >/dev/null || setsid nohup .venv/bin/celery -A app.worker.celery_app worker --concurrency 1 -Q reconstruction --loglevel INFO > "$LOGS/worker.log" 2>&1 &
  sleep 3
  curl -sf http://127.0.0.1:8000/api/health && echo " API lista en http://127.0.0.1:8000 (docs: /docs)"
}

down() {
  pkill -f "celery -A app.worker.celery_app" || true
  pkill -f "uvicorn app.main:app" || true
  redis-cli -h 127.0.0.1 shutdown nosave >/dev/null 2>&1 || true
  as_pg "$PGBIN/pg_ctl -D $PGDATA -m fast stop" || true
}

status() {
  pgrep -af "uvicorn app.main:app" || echo "API detenida"
  pgrep -af "celery -A app.worker.celery_app" | head -1 || echo "Trabajador detenido"
  redis-cli -h 127.0.0.1 ping 2>/dev/null || echo "Redis detenido"
  as_pg "$PGBIN/pg_ctl -D $PGDATA status" | head -1 || true
}

"${1:-up}"
