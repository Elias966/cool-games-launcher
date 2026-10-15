// electron-builder afterPack hook (Linux): installs a small launcher wrapper.
//
// Chromium's sandbox needs unprivileged user namespaces. Some distributions
// (Ubuntu 24.04+ via AppArmor) restrict them, and an AppImage cannot ship the
// setuid fallback helper, so Electron would abort before any app code runs.
// The wrapper keeps the sandbox wherever it works and only adds --no-sandbox
// when user namespaces are unavailable. Website content never runs in Electron
// (it stays inside the bundled Firefox, which has its own sandbox).
const { renameSync, writeFileSync, chmodSync, existsSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const exe = context.packager.executableName;
  const dir = context.appOutDir;
  const bin = join(dir, exe);
  const real = join(dir, `${exe}.bin`);
  if (!existsSync(real)) renameSync(bin, real);
  writeFileSync(
    bin,
    `#!/bin/sh
# Cool Games Launcher wrapper — see scripts/after-pack.cjs in the source tree.
HERE="$(dirname "$(readlink -f "$0")")"
EXTRA=""
userns_ok() {
  # Prefer the kernel/AppArmor switches; fall back to a quick probe.
  if [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] && [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = "1" ]; then return 1; fi
  if [ -r /proc/sys/kernel/unprivileged_userns_clone ] && [ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" = "0" ]; then return 1; fi
  if command -v unshare >/dev/null 2>&1; then unshare -Ur true >/dev/null 2>&1 || return 1; fi
  return 0
}
if ! userns_ok; then
  echo "cool-games-launcher: unprivileged user namespaces are restricted on this system; starting without the Chromium sandbox." >&2
  EXTRA="--no-sandbox"
fi
exec "$HERE/${exe}.bin" $EXTRA "$@"
`,
  );
  chmodSync(bin, 0o755);
};
