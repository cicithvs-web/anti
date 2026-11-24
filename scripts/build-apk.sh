#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_URL="${APP_URL:-https://gay.my.id}"
VERSION_NAME="${VERSION_NAME:-1.0.4}"
VERSION_CODE="${VERSION_CODE:-5}"
IMAGE_NAME="antigpt-android-builder:latest"

mkdir -p "${ROOT_DIR}/android/keystore" "${ROOT_DIR}/releases"

if ! docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
  echo "[apk] Membangun Docker image builder Android (sekali saja)..."
  docker build -f "${ROOT_DIR}/android/Dockerfile.build" -t "${IMAGE_NAME}" "${ROOT_DIR}/android"
fi

echo "[apk] Menyusun APK release untuk ${APP_URL} (v${VERSION_NAME}, code ${VERSION_CODE})..."
docker run --rm \
  -v "${ROOT_DIR}/android:/workspace" \
  -v antigpt-gradle-cache:/root/.gradle \
  -e APP_URL="${APP_URL}" \
  -e VERSION_NAME="${VERSION_NAME}" \
  -e VERSION_CODE="${VERSION_CODE}" \
  "${IMAGE_NAME}" \
  bash -lc '
    set -euo pipefail
    KS=/workspace/keystore/antigpt-release.jks
    KS_PASS="${ANTIGPT_KS_PASS:-antigpt-release-2026}"
    KS_ALIAS="${ANTIGPT_KS_ALIAS:-antigpt}"
    if [ ! -f "$KS" ]; then
      echo "[apk] Membuat release keystore baru..."
      keytool -genkeypair -v \
        -keystore "$KS" \
        -storetype PKCS12 \
        -alias "$KS_ALIAS" \
        -keyalg RSA -keysize 2048 -validity 10000 \
        -storepass "$KS_PASS" -keypass "$KS_PASS" \
        -dname "CN=AntiGPT, OU=Mobile, O=AntiGPT, L=Jakarta, S=DKI, C=ID"
    fi
    gradle --no-daemon assembleRelease \
      -PAPP_URL="${APP_URL}" \
      -PVERSION_NAME="${VERSION_NAME}" \
      -PVERSION_CODE="${VERSION_CODE}"
    APK=/workspace/app/build/outputs/apk/release/app-release.apk
    echo "[apk] Verifikasi tanda tangan APK dengan apksigner..."
    apksigner verify --verbose "$APK"
  '

APK_SRC="${ROOT_DIR}/android/app/build/outputs/apk/release/app-release.apk"
APK_DST="${ROOT_DIR}/releases/AntiGPT.apk"
cp -f "${APK_SRC}" "${APK_DST}"
SHA256="$(sha256sum "${APK_DST}" | awk '{print $1}')"
BUILT_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

cat > "${ROOT_DIR}/releases/apk-meta.json" <<EOF
{
  "appUrl": "${APP_URL}",
  "versionName": "${VERSION_NAME}",
  "versionCode": ${VERSION_CODE},
  "builtAt": "${BUILT_AT}",
  "sha256": "${SHA256}"
}
EOF

echo "[apk] Selesai! APK siap di: ${APK_DST}"
ls -lh "${APK_DST}"
echo "[apk] SHA-256: ${SHA256}"
