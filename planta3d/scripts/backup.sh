#!/usr/bin/env bash
# Respaldo de metadatos (PostgreSQL) y archivos (originales, copias de trabajo, modelos, documentos).
# Uso local:  scripts/backup.sh /ruta/respaldos            (usa P3D_DATABASE_URL y P3D_DATA_DIR de backend/.env)
# Uso Docker: scripts/backup.sh /ruta/respaldos --docker   (desde la carpeta planta3d, con compose activo)
set -euo pipefail
DEST="${1:?indica carpeta de destino}"; MODE="${2:-}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; OUT="$DEST/planta3d-$STAMP"; mkdir -p "$OUT"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$MODE" = "--docker" ]; then
  docker compose -f "$ROOT/deploy/docker-compose.yml" exec -T db pg_dump -U planta3d -Fc planta3d > "$OUT/db.dump"
  docker compose -f "$ROOT/deploy/docker-compose.yml" exec -T api tar -C /data --exclude=./tmp --exclude=./jobs -cf - . > "$OUT/data.tar"
else
  set -a; . "${P3D_ENV_FILE:-$ROOT/backend/.env}"; set +a
  DBURL="${P3D_DATABASE_URL:-postgresql+psycopg://planta3d:planta3d_dev@127.0.0.1:5432/planta3d}"; URL="${DBURL/postgresql+psycopg/postgresql}"
  pg_dump -Fc "$URL" > "$OUT/db.dump"
  DATA="${P3D_DATA_DIR:-$ROOT/backend/data}"; [ "${DATA:0:1}" = "/" ] || DATA="$ROOT/backend/$DATA"
  tar -C "$DATA" --exclude=./tmp --exclude=./jobs -cf "$OUT/data.tar" .
fi
( cd "$OUT" && sha256sum db.dump data.tar > SHA256SUMS )
echo "Respaldo en $OUT (verifica con: cd $OUT && sha256sum -c SHA256SUMS)"
