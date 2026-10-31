#!/usr/bin/env bash
# Android release builds from one code base:
#   Google Play: the signed App Bundle (upload key)        app/scripts/android-release.sh [build-number 0..99]
#   Direct download: the signed APK for host-caster.com    app/scripts/android-release.sh --direct [build-number]
# Both: the web app without debug tools or source maps, default server VITE_HOSTCASTER_SERVER or
# https://app.host-caster.com, Capacitor sync, R8. Same versionCode scheme (see app/android/app/build.gradle).
#
#   source <your Android env: JAVA_HOME (JDK 21), ANDROID_HOME (SDK 36)>
#
# Play output in release/play/: host-caster-<version>-<versionCode>.aab, its R8 mapping file (upload it in the Play
# Console with the bundle so crash reports are readable) and a SHA-256 list. Signed with the upload key.
# Direct output in release/direct/: host-caster-<version>-<versionCode>.apk, mapping and SHA-256. Signed with the APP
# SIGNING key (the one enrolled as the Play App Signing key, see release/play/SUBMIT.md) so Google Play can update
# it later. Only the direct build shows the in-app "A new version is ready" notice (VITE_HOSTCASTER_DISTRIBUTION).
# Publish it on the website with: node website/scripts/publish-android.mjs release/direct/<file>.apk
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/.." && pwd)"
distribution=play
if [ "${1:-}" = "--direct" ]; then distribution=direct; shift; fi
out="$repo/release/$distribution"
web="$(mktemp -d "${TMPDIR:-/tmp}/hostcaster-release-web.XXXXXX")"
build="${1:-${HOSTCASTER_BUILD:-0}}"
trap 'rm -rf "$web"' EXIT

: "${JAVA_HOME:?set JAVA_HOME to a JDK 21}"
: "${ANDROID_HOME:?set ANDROID_HOME to the Android SDK}"

cd "$here"
echo "== web build (release, $distribution)"
unset HOSTCASTER_SOURCEMAP
VITE_HOSTCASTER_DEBUG=0 VITE_HOSTCASTER_DISTRIBUTION="$distribution" npx vite build --outDir "$web" --emptyOutDir --logLevel warn
if grep -rlq "sourceMappingURL" "$web/assets" 2>/dev/null || ls "$web"/assets/*.map >/dev/null 2>&1; then
  echo "source maps found in the release build" >&2
  exit 1
fi

echo "== capacitor sync"
HOSTCASTER_WEB_DIR="$web" npx cap sync android >/dev/null

version="$(node -p "require('$here/package.json').version")"
code="$(node -p "const [a,b,c]=require('$here/package.json').version.split(/[.+-]/).map(Number); a*1e6+b*1e4+c*100+Number('$build')")"
name="host-caster-$version-$code"
mkdir -p "$out"
cd android

if [ "$distribution" = direct ]; then
  echo "== assembleRelease (direct, build $build)"
  ./gradlew --console=plain -q assembleRelease -PhostcasterBuild="$build" -PhostcasterDistribution=direct 2>&1 | grep -v '^Note:' || true
  apk="app/build/outputs/apk/release/app-release.apk"
  [ -f "$apk" ] || { echo "no APK at $apk" >&2; exit 1; }
  cp "$apk" "$out/$name.apk"
  [ -f app/build/outputs/mapping/release/mapping.txt ] && cp app/build/outputs/mapping/release/mapping.txt "$out/$name-mapping.txt"
  (cd "$out" && sha256sum "$name.apk" > "$name.sha256")
  # The APK must carry the app signing certificate, not the upload key or a debug key.
  apksigner="$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner | sort -V | tail -1)"
  "$apksigner" verify --print-certs "$out/$name.apk" | grep -m1 'certificate SHA-256 digest' || { echo "APK is not signed" >&2; exit 1; }
  echo "== $out/$name.apk"
  exit 0
fi

echo "== bundleRelease (build $build)"
./gradlew --console=plain -q bundleRelease -PhostcasterBuild="$build" 2>&1 | grep -v '^Note:' || true
aab="app/build/outputs/bundle/release/app-release.aab"
[ -f "$aab" ] || { echo "no bundle at $aab" >&2; exit 1; }
cp "$aab" "$out/$name.aab"
[ -f app/build/outputs/mapping/release/mapping.txt ] && cp app/build/outputs/mapping/release/mapping.txt "$out/$name-mapping.txt"
(cd "$out" && sha256sum "$name.aab" > "$name.sha256")
if "$JAVA_HOME/bin/jarsigner" -verify "$out/$name.aab" >/dev/null 2>&1; then echo "signed: yes"; else echo "signed: NO (no upload key properties found)"; fi
echo "== $out/$name.aab"
