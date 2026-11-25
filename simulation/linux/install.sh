#!/bin/bash
set -euo pipefail
source /etc/os-release
[[ $EUID == 0 && $ID == debian && $VERSION_ID == 13 ]]
stage=$(realpath "${1:?Indique el directorio compilado}")
dest=/opt/sd-lab
rev=bff1f5890a6929719a241fe7ed8c40efd4b95860
[[ $(/usr/bin/node -p 'process.versions.node.split(".")[0]') == 24 ]]
[[ $(cat "$stage/services/REVISION") == "$rev" ]]
for bin in /usr/bin/ss /usr/bin/python3 /usr/bin/systemctl /usr/bin/curl /usr/lib/postgresql/18/bin/pg_restore; do test -x "$bin"; done
for file in services/apps/{api,orchestrator}/dist/main.js simulation/dist/local/institutional.js simulation/lab-ui/.next/BUILD_ID; do test -s "$stage/$file"; done
for path in "$dest" /etc/sd-lab /var/lib/sd-lab /etc/systemd/system/sd-lab-*; do
  [[ ! -e "$path" && ! -L "$path" ]] || { echo "Instalación previa: $path" >&2; exit 1; }
done
for user in sd-lab sd-lab-api sd-lab-orch; do
  if getent passwd "$user" >/dev/null || getent group "$user" >/dev/null; then echo "Cuenta existente: $user" >&2; exit 1; fi
done
for user in sd-lab sd-lab-api sd-lab-orch; do useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$user"; done
install -d -m 0755 "$dest" /etc/sd-lab /var/lib/sd-lab
cp -a --no-preserve=ownership "$stage/simulation" "$stage/services" "$dest/"
chmod -R go-w "$dest"
install -d -m 0750 -g sd-lab /etc/sd-lab/runner
install -d -m 0700 -o sd-lab -g sd-lab /var/lib/sd-lab/reports
src="$dest/simulation/linux"
for file in api issuer orchestrator verifier runner/{simulation,actors,institution}; do
  case "$file" in api|issuer) group=sd-lab-api;; orchestrator|verifier) group=sd-lab-orch;; *) group=sd-lab;; esac
  install -m 0640 -g "$group" "$src/env/$file.env.example" "/etc/sd-lab/$file.env"
done
install -m 0644 "$src"/units/* /etc/systemd/system/
systemctl daemon-reload
