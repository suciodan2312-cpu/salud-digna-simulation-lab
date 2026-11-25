"""Fixed, read-only systemd socket helper. Never processes client input."""
import json
import re
import subprocess

UNITS = {
    "central": ("sd-lab-api.service", 13104),
    "orchestrator": ("sd-lab-orchestrator.service", 13304),
    "postgres": ("postgresql@18-simlab.service", 55436),
}


def verify(rows, port, pid):
    matches = [fields for line in rows.splitlines() if len(fields := line.split()) >= 5
               and fields[3].rsplit(":", 1)[-1] == str(port)]
    if pid <= 0 or len(matches) != 1 or matches[0][3] != f"127.0.0.1:{port}" or not re.search(
            rf"\bpid={pid},", " ".join(matches[0][5:])):
        raise ValueError("Listener incompatible")


def main():
    ids = {name: int(subprocess.check_output(
        ["/usr/bin/systemctl", "show", "--property=MainPID", "--value", unit], timeout=1))
        for name, (unit, _) in UNITS.items()}
    rows = subprocess.check_output(["/usr/bin/ss", "-H", "-lntp"], text=True, timeout=1)
    for name, (_, port) in UNITS.items():
        verify(rows, port, ids[name])
    print(json.dumps(ids))


if __name__ == "__main__":
    main()
