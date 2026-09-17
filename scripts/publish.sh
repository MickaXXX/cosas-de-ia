#!/usr/bin/env bash
# Publica los datos generados. Un solo lugar para los cuatro workflows.
#
# El paso de publicar hacía "git pull --rebase --autostash || true" y luego
# commiteaba a ciegas: cuando dos runs chocaban, el rebase fallaba, el "|| true"
# se lo tragaba y subían los archivos con los marcadores <<<<<<< dentro. La app
# quedaba sin poder leer sus propios datos.
#
# Ahora:
#   1. Se valida que cada JSON parsee ANTES de commitear. Si uno está roto, el
#      run falla y no se publica nada: es mejor quedarse con datos de hace una
#      hora que con datos ilegibles.
#   2. El commit se hace primero y el merge después con "-X ours": estos
#      archivos son fotos completas del estado, no ediciones colaborativas, así
#      que ante un choque manda la que acabamos de generar.
#   3. Si el merge deja algún conflicto, se resuelve tomando nuestra versión y
#      se vuelve a validar.
#
# Uso: scripts/publish.sh "mensaje de commit" archivo1 archivo2 …
set -euo pipefail

MSG="$1"; shift
FILES=("$@")

# --- 1. validación: ningún JSON roto llega al repositorio --------------------
EXISTENTES=()
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "· $f no existe, se omite"; continue; }
  EXISTENTES+=("$f")
  case "$f" in
    *.json)
      python3 - "$f" <<'PY'
import json, sys
ruta = sys.argv[1]
with open(ruta, encoding="utf-8") as fh:
    texto = fh.read()
for marca in ("<<<<<<<", ">>>>>>>", "=======\n{"):
    if marca in texto[:200000]:
        sys.exit(f"::error::{ruta} trae marcadores de conflicto de git")
try:
    json.loads(texto)
except json.JSONDecodeError as e:
    sys.exit(f"::error::{ruta} no es JSON válido: {e}")
print(f"  ok {ruta} ({len(texto) / 1024:.0f} KB)")
PY
      ;;
  esac
done
[ ${#EXISTENTES[@]} -gt 0 ] || { echo "Nada que publicar."; exit 0; }

# --- 2. commit primero, sincronización después ------------------------------
git config user.name "market-intelligence-bot"
git config user.email "actions@users.noreply.github.com"
git add "${EXISTENTES[@]}"
if git diff --cached --quiet; then
  echo "Sin cambios."
  exit 0
fi
git commit -m "$MSG"

RAMA="${GITHUB_REF_NAME:-main}"
for intento in 1 2 3; do
  git fetch origin "$RAMA"
  # Estos archivos son snapshots: ante un choque gana el que acabamos de generar.
  if ! git merge -X ours --no-edit "origin/$RAMA"; then
    git checkout --ours -- "${EXISTENTES[@]}" 2>/dev/null || true
    git add "${EXISTENTES[@]}"
    git commit --no-edit
  fi
  # Tras el merge, revalidar: nunca empujar algo que no parsee.
  for f in "${EXISTENTES[@]}"; do
    case "$f" in
      *.json) python3 -c "import json,sys; json.load(open(sys.argv[1], encoding='utf-8'))" "$f" ;;
    esac
  done
  if git push origin "HEAD:$RAMA"; then
    echo "Publicado en $RAMA (intento $intento)."
    exit 0
  fi
  echo "· push rechazado, reintento $intento"
  sleep $((intento * 5))
done
echo "::error::no se pudo publicar tras 3 intentos"
exit 1
