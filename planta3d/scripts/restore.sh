#!/usr/bin/env bash
# Restaura un respaldo creado con backup.sh en una instalación LOCAL detenida (API y trabajador apagados).
# Uso: scripts/restore.sh /ruta/respaldos/planta3d-AAAAMMDDTHHMMSSZ
set -euo pipefail
SRC="${1:?carpeta de respaldo}"; ROOT="$(cd "$(dirname "$0")/.." && pwd)"
( cd "$SRC" && sha256sum -c SHA256SUMS )
set -a; . "${P3D_ENV_FILE:-$ROOT/backend/.env}"; set +a
DBURL="${P3D_DATABASE_URL:-postgresql+psycopg://planta3d:planta3d_dev@127.0.0.1:5432/planta3d}"; URL="${DBURL/postgresql+psycopg/postgresql}"
pg_restore --clean --if-exists --no-owner -d "$URL" "$SRC/db.dump"
DATA="${P3D_DATA_DIR:-$ROOT/backend/data}"; [ "${DATA:0:1}" = "/" ] || DATA="$ROOT/backend/$DATA"
mkdir -p "$DATA" && tar -C "$DATA" -xf "$SRC/data.tar"
echo "Restaurado. Inicia los servicios con scripts/dev_local.sh up"
