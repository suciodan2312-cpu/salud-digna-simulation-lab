#!/bin/bash
set -euo pipefail
[[ $EUID == 0 ]]
for f in /etc/sd-lab/{api,issuer,orchestrator,verifier,runner/{actors,institution,simulation}}.env; do
  [[ -s $f ]] && ! grep -q 'REPLACE_' "$f" || { echo "Completar $f" >&2; exit 1; }
done
state=/var/lib/sd-lab/reports
meta="$state/datasets/83c9d0aa989ec6d1d2ea1e17"
for f in manifest.json copy-journal.jsonl; do test -s "$meta/$f"; done
cd /opt/sd-lab/simulation
SIM_LOCAL_LAB=integration-5m /usr/bin/node linux/config-check.mjs
systemctl start postgresql@18-simlab.service
runuser -u sd-lab -- env SIM_LOCAL_LAB=integration-5m /usr/bin/node --env-file=/etc/sd-lab/runner/simulation.env --input-type=module -e 'import {databases} from "./dist/local/monitor.js"; await databases()'
systemctl start sd-lab-api.service sd-lab-orchestrator.service sd-lab-bindings.socket
for url in http://127.0.0.1:13104/api/v1/health/db http://127.0.0.1:13304/api/v1/health; do
  curl --noproxy '*' --fail --silent --show-error --retry 20 --retry-connrefused --retry-delay 1 --max-time 3 "$url" >/dev/null
done
runuser -u sd-lab -- env SIM_LOCAL_LAB=integration-5m /usr/bin/node --input-type=module -e 'import {linuxBindings} from "./dist/local/linux-bindings.js"; await linuxBindings()'
systemctl start sd-lab-panel.service
curl --noproxy '*' --fail --silent --show-error --retry 20 --retry-connrefused --retry-delay 1 --max-time 3 http://127.0.0.1:13400/ >/dev/null
echo 'Simulation Lab: http://127.0.0.1:13400'
