#!/usr/bin/env bash
# Runs the desktop e2e on a virtual screen: Xvfb 1440x900, the xfwm4 window manager when it is installed (so minimize
# works) and a private D-Bus session (the MPRIS check never touches the desktop you are logged in to).
# Usage: [env...] desktop/e2e/run-xvfb.sh   e.g. BRAIN_URL=... BRAIN_MODEL=... VOICE_URL=... desktop/e2e/run-xvfb.sh
#        HC_E2E=desktop/e2e/smoke.mjs HC_EXE=<packaged app> desktop/e2e/run-xvfb.sh   (the launch smoke test)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export HC_E2E="${HC_E2E:-$here/e2e/desktop.e2e.mjs}"
# the public source has no online lab: there the default is the launch smoke test (HC_EXE = a packaged app)
[ -f "$HC_E2E" ] || HC_E2E="$here/e2e/smoke.mjs"
# Chromium's basic key store: the run never reads or writes the keyring of the person logged in
export HOSTCASTER_PASSWORD_STORE="${HOSTCASTER_PASSWORD_STORE:-basic}"
# a session bus that starts no services (no desktop portal or keyring waking up and stalling Chromium's start)
bus_conf="$(mktemp /tmp/hc-desktop-bus.XXXXXX.conf)"
cat > "$bus_conf" <<'CONF'
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
CONF
trap 'rm -f "$bus_conf"' EXIT
xvfb-run -a -s "-screen 0 1440x900x24" dbus-run-session --config-file="$bus_conf" -- bash -c '
  if command -v xfwm4 >/dev/null 2>&1; then
    xfwm4 --compositor=off >/dev/null 2>&1 &
    export HC_WM=1
    sleep 1
  fi
  export HC_PRIVATE_DBUS=1
  exec node "$HC_E2E"
'
