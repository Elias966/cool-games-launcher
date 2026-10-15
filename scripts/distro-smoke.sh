#!/usr/bin/env bash
# Rootless cross-distro AppImage smoke test. Requires python3, bwrap and Xvfb.
# Usage: scripts/distro-smoke.sh /absolute/path/app.AppImage [scratch-dir] [ubuntu22 ubuntu24 debian12 fedora42 wayland]
set -euo pipefail
appimage=$(realpath "${1:?Pass the built AppImage}")
scratch=$(realpath -m "${2:-/tmp/cgl-distro-smoke}")
shift; if [ "$#" -gt 0 ]; then shift; fi
if [ "$#" -eq 0 ]; then set -- ubuntu22 ubuntu24 debian12 fedora42 wayland; fi
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$scratch"
for required in bwrap python3 Xvfb cc; do command -v "$required" >/dev/null; done
bwrap --unshare-user --uid 0 --gid 0 --ro-bind / / /bin/true
# Avoid the host's AppImageLauncher binfmt interception; payload remains exact.
python3 - "$appimage" "$scratch/test.AppImage" <<'PY'
import shutil, sys
shutil.copyfile(sys.argv[1], sys.argv[2])
with open(sys.argv[2], 'r+b') as f: f.seek(8); f.write(b'\0\0\0')
PY
chmod +x "$scratch/test.AppImage"
cc -shared -fPIC -nostdlib "$script_dir/rootless-ownership.c" -o "$scratch/rootless-ownership.so"
: > "$scratch/display"
Xvfb -displayfd 3 -screen 0 1480x920x24 -ac 3>"$scratch/display" >"$scratch/xvfb.log" 2>&1 &
xvfb_pid=$!
trap 'kill "$xvfb_pid" 2>/dev/null || true' EXIT
for n in {1..100}; do [ -s "$scratch/display" ] && break; sleep 0.1; done
[ -s "$scratch/display" ] || { echo "Xvfb did not start" >&2; exit 1; }
display=":$(cat "$scratch/display")"
failures=0
for target in "$@"; do
  distro=$target; [ "$target" != wayland ] || distro=ubuntu24
  python3 "$script_dir/fetch-smoke-rootfs.py" "$distro" "$scratch/rootfs"
  root="$scratch/rootfs/$distro"
  run_dir="$scratch/run-$target"; mkdir -p "$run_dir/runtime" "$run_dir/tmp"; cp "$scratch/rootless-ownership.so" "$run_dir/"; chmod 700 "$run_dir/runtime"
  guest=(bwrap --unshare-user --unshare-pid --die-with-parent --uid 0 --gid 0 --bind "$root" / --dev /dev --proc /proc --tmpfs /tmp --ro-bind /etc/resolv.conf /etc/resolv.conf --ro-bind /tmp/.X11-unix /tmp/.X11-unix --bind "$run_dir" /test --ro-bind "$scratch/test.AppImage" /launcher.AppImage --setenv DISPLAY "$display" --setenv XDG_DATA_HOME /test/data --setenv XDG_CACHE_HOME /test/cache --setenv XDG_CONFIG_HOME /test/config --setenv XDG_RUNTIME_DIR /test/runtime --setenv TMPDIR /test/tmp --chdir /test)
  if [ ! -f "$root/.cgl-desktop-ready" ]; then
    if [ "$distro" = fedora42 ]; then
      # Service-user scriptlets and file capabilities cannot work in a single-ID
      # namespace. They are unnecessary for this disposable desktop-library test.
      "${guest[@]}" --setenv LD_PRELOAD /test/rootless-ownership.so /bin/sh -c 'dnf -y --setopt=install_weak_deps=False --setopt=tsflags=noscripts,nocaps install gtk3 nss alsa-lib mesa-libgbm libXScrnSaver dbus-glib python3 xz bzip2 libXtst procps-ng libglvnd-glx mesa-dri-drivers'
    else
      alsa=libasound2; gtk=libgtk-3-0; [ "$distro" != ubuntu24 ] || { alsa=libasound2t64; gtk=libgtk-3-0t64; }
      "${guest[@]}" --setenv LD_PRELOAD /test/rootless-ownership.so /bin/sh -c 'dpkg --configure -a && apt-get -o APT::Sandbox::User=root update && DEBIAN_FRONTEND=noninteractive apt-get -o APT::Sandbox::User=root install -y --no-install-recommends "$2" libnss3 "$1" libgbm1 libxss1 libdbus-glib-1-2 libxtst6 python3 xz-utils bzip2 ca-certificates procps libgl1 libgl1-mesa-dri weston' sh "$alsa" "$gtk"
    fi
    touch "$root/.cgl-desktop-ready"
  fi
  # Fixture is intentionally deterministic and needs no cloud AI or live website.
  cp "$script_dir/smoke-guest.py" "$run_dir/guest.py"
  cp "$script_dir/../tests/fixtures/test_read_format_rar.rar" "$run_dir/decoder-fixture.rar"
  cp "$scratch/display" "$run_dir/display"
  echo "Testing $target (logs: $run_dir)"
  if "${guest[@]}" /usr/bin/python3 /test/guest.py "$target" >"$run_dir/harness.log" 2>&1; then
    echo "$target PASS" | tee -a "$scratch/results.txt"
  else
    echo "$target FAIL (see $run_dir/harness.log and app.log)" | tee -a "$scratch/results.txt"
    failures=$((failures + 1))
  fi
 done
[ "$failures" -eq 0 ]
