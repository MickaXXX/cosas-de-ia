#!/usr/bin/env bash
# Compila OpenMVS v2.4.0 (CPU) en /opt/openmvs para Ubuntu 24.04 / WSL2. Probado en Ubuntu 24.04 x86_64.
# Uso: sudo bash scripts/build_openmvs.sh [directorio_de_trabajo]   (CUDA: OPENMVS_CUDA=ON, no probado)
set -euo pipefail
WORK="${1:-/tmp/openmvs-build}"
PATCH="$(cd "$(dirname "$0")/.." && pwd)/deploy/openmvs/opencv46-jpegxl-compat.patch"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq git build-essential cmake pkg-config libpng-dev libjpeg-dev libtiff-dev libjxl-dev \
  libeigen3-dev libnanoflann-dev libopencv-dev libgmp-dev libmpfr-dev zlib1g-dev \
  libboost-iostreams-dev libboost-program-options-dev libboost-system-dev libboost-serialization-dev libboost-thread-dev
mkdir -p "$WORK" && cd "$WORK"
# OpenMVS 2.4 requiere CGAL 6 (Ubuntu 24.04 trae 5.6). CGAL es de solo cabeceras.
[ -d cgal ] || git clone --depth 1 --branch v6.0.1 https://github.com/CGAL/cgal.git cgal
cmake -S cgal -B cgal-build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/cgal6 >/dev/null
cmake --install cgal-build >/dev/null
[ -d vcglib ] || git clone https://github.com/cdcseacave/VCG.git vcglib
[ -d openMVS ] || git clone --depth 1 --branch v2.4.0 https://github.com/cdcseacave/openMVS.git openMVS
# OpenCV 4.6 (Ubuntu) no define IMWRITE_JPEGXL_QUALITY: parche mínimo, publicado en deploy/openmvs/.
(cd openMVS && (git apply --check "$PATCH" 2>/dev/null && git apply "$PATCH") || true)
cmake -S openMVS -B build -DCMAKE_BUILD_TYPE=Release -DVCG_ROOT="$WORK/vcglib" -DCGAL_DIR=/opt/cgal6/lib/cmake/CGAL \
  -DOpenMVS_USE_CUDA="${OPENMVS_CUDA:-OFF}" -DOpenMVS_BUILD_VIEWER=OFF -DOpenMVS_USE_PYTHON=OFF \
  -DOpenMVS_USE_BREAKPAD=OFF -DCMAKE_INSTALL_PREFIX=/opt/openmvs
cmake --build build -j"$(nproc)"
cmake --install build
/opt/openmvs/bin/OpenMVS/DensifyPointCloud --help 2>&1 | grep -m1 "OpenMVS"
echo "OpenMVS instalado en /opt/openmvs/bin/OpenMVS"
