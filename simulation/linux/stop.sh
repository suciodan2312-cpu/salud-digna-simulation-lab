#!/bin/bash
set -euo pipefail
[[ $EUID == 0 && $# == 0 ]]
if [[ -e /var/lib/sd-lab/reports/phase5-execution.lock ]]; then
  echo 'Detenga el recorrido en el panel y espere su cierre antes de apagar.' >&2
  exit 1
fi
systemctl stop sd-lab-panel.service
systemctl stop sd-lab-bindings.socket sd-lab-api.service sd-lab-orchestrator.service
