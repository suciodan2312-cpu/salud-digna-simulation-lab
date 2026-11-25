# Simulation Lab en Debian 13

El primer despliegue habilita el panel y un recorrido institucional entre los canales sintéticos web y WhatsApp. La revisión de los servicios es `bff1f5890a6929719a241fe7ed8c40efd4b95860`. El manifiesto del corpus `83c9d0aa989ec6d1d2ea1e17` conserva la revisión original `ff989cc`. Windows sigue siendo el respaldo. Reserve un host o VM dedicado con systemd, cgroups con filtrado IP, Debian 13, PostgreSQL 18 (servidor y cliente), /usr/bin/node 24, Corepack con pnpm 11.28.11, git, curl, iproute2 y Python 3. Dimensione disco para ambos dumps, bases, índices, WAL y margen de restauración, según las medidas del origen.

## Construcción e instalación

Desde el repositorio revisado, como usuario de compilación, use un directorio nuevo. SIM debe identificar un commit que incluya esta portabilidad. Configure SIM_SERVICES_REPO con la ruta absoluta del repositorio privado de servicios. El árbol de distribución debe proceder de una compilación confiable en Debian y todos sus enlaces de ejecución deben resolver dentro del árbol. No copie node_modules de Windows.

```bash
set -euo pipefail
umask 022
SIM=$(git rev-parse HEAD)
REV=bff1f5890a6929719a241fe7ed8c40efd4b95860
stage=$(mktemp -d)
mkdir "$stage/services"
git archive "$SIM" simulation | tar -x -C "$stage"
git -C "${SIM_SERVICES_REPO:?Indique el checkout privado de servicios}" archive "$REV" | tar -x -C "$stage/services"
printf '%s\n' "$REV" > "$stage/services/REVISION"
(cd "$stage/services"
 corepack pnpm --filter @salud-digna/api --filter @salud-digna/orchestrator install --frozen-lockfile
 OPENAPI_EXPORT=true corepack pnpm --filter @salud-digna/api prisma:generate
 corepack pnpm --filter @salud-digna/api exec tsc
 corepack pnpm --filter @salud-digna/orchestrator prisma:generate
 corepack pnpm --filter @salud-digna/orchestrator exec tsc)
for project in "$stage/simulation" "$stage/simulation/lab-ui"; do
 (cd "$project" && corepack pnpm install --frozen-lockfile && NEXT_TELEMETRY_DISABLED=1 corepack pnpm build)
done
sudo bash "$stage/simulation/linux/install.sh" "$stage"
```

El instalador prepara una instalación nueva bajo /opt/sd-lab. El panel, la API y el orquestador ejecutan con tres usuarios Unix distintos. Los archivos en /etc/sd-lab son root:grupo 0640. Complete las siete plantillas instaladas con sudoedit y material exclusivo del laboratorio. El paciente @example.test debe existir en el respaldo. Conserve las claves sintéticas de canales asociadas a los digests restaurados, las claves HMAC e identidad correspondientes y el par de firma/verificación del emisor. Use el formato de issuer.env y verifier.env ya validado, con PEM entre comillas. Proteja y transfiera estos valores por un canal privado independiente. Use contraseñas nuevas para los dos roles PostgreSQL y codifíquelas para URL en los respectivos archivos. El servicio API usa modo development para su health/db local. Las integraciones externas permanecen desactivadas.

## Transferencia del corpus 5M

1. En el origen autorizado integration-5m (127.0.0.1:55436), pause las operaciones que escriben hasta completar ambos dumps. Verifique en cada base la marca `salud-digna:synthetic-only` con `SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()`. Con cliente 18, almacene en un directorio privado dos respaldos completos y un inventario por base de migraciones terminadas (nombre y checksum desde _prisma_migrations). Guarde los conteos de cada tabla pública, incluidos los actores posteriores al COPY, para comparar en destino. Los dumps contienen credenciales sintéticas derivadas y datos de autenticación. Restrinja su acceso.

```text
pg_dump -h 127.0.0.1 -p 55436 -U sim_central_app -d salud_digna_simulation -Fc -f central.dump
pg_dump -h 127.0.0.1 -p 55436 -U salud_digna_orchestrator_app -d salud_digna_orchestrator -Fc -f orchestrator.dump
```

2. Copie también manifest.json y copy-journal.jsonl del directorio del dataset y, opcionalmente, solo los reportes saneados que se quieran presentar. Calcule SHA-256 de los respaldos, manifiesto y journal con Get-FileHash en origen. Transfiera por SSH al host autorizado y contraste con sha256sum en destino. Use archivos de claves fuera de Git y respaldos cifrados en reposo.
3. En una instalación nueva confirme con pg_lsclusters y ss que nombre y puerto están libres. Cree el clúster con `sudo pg_createcluster 18 simlab --port=55436`. Configure listen_addresses='127.0.0.1', password_encryption='scram-sha-256', acceso TCP local por SCRAM en pg_hba.conf y autenticación peer local para administración. Arranque únicamente `sudo systemctl start postgresql@18-simlab`. Desde `sudo -u postgres psql -X -p 55436 -d postgres -v ON_ERROR_STOP=1` ejecute lo siguiente, una sola vez.

```sql
CREATE ROLE sim_central_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE salud_digna_orchestrator_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
\password sim_central_app
\password salud_digna_orchestrator_app
CREATE DATABASE salud_digna_simulation OWNER sim_central_app TEMPLATE template0;
CREATE DATABASE salud_digna_orchestrator OWNER salud_digna_orchestrator_app TEMPLATE template0;
REVOKE ALL ON DATABASE salud_digna_simulation FROM PUBLIC;
REVOKE ALL ON DATABASE salud_digna_orchestrator FROM PUBLIC;
COMMENT ON DATABASE salud_digna_simulation IS 'salud-digna:synthetic-only';
COMMENT ON DATABASE salud_digna_orchestrator IS 'salud-digna:synthetic-only';
```

4. Confirme bases vacías y nombres/puerto antes de restaurar. Use el cliente 18, con solicitud interactiva de contraseña o PGPASSFILE 0600. Cada rol restaura sus propios objetos. Se reconstruyen las restricciones e índices. Ante un fallo, retenga la instalación para diagnóstico y prepare otro destino vacío antes de repetir.

```bash
pg_restore -h 127.0.0.1 -p 55436 -U sim_central_app -d salud_digna_simulation --no-owner --no-acl --single-transaction --exit-on-error central.dump
pg_restore -h 127.0.0.1 -p 55436 -U salud_digna_orchestrator_app -d salud_digna_orchestrator --no-owner --no-acl --single-transaction --exit-on-error orchestrator.dump
meta=/var/lib/sd-lab/reports/datasets/83c9d0aa989ec6d1d2ea1e17
sudo install -d -m 0750 -g sd-lab "$meta"
sudo install -m 0640 -g sd-lab manifest.json copy-journal.jsonl "$meta/"
cd /opt/sd-lab/simulation
sudo -u sd-lab env SIM_LOCAL_LAB=integration-5m /usr/bin/node --env-file=/etc/sd-lab/runner/simulation.env linux/verify-restore.mjs
```

Compare también inventarios completos y checksums de migraciones origen/destino antes de abrir los servicios. El verificador comprueba versión 18, propietario y usuario por base, marca sintética, ambos commits del journal, identificador, SHA del esquema, restricciones validadas y conteos históricos de las 16 tablas por prefijo reproducible. El total histórico debe ser cinco millones. Los actores activos se cuentan aparte en el inventario completo. Los CSV originales de COPY no son necesarios para este despliegue.

## Operación

```bash
sudo bash /opt/sd-lab/simulation/linux/start.sh
# En el propio host abra http://127.0.0.1:13400
sudo bash /opt/sd-lab/simulation/linux/stop.sh
```

Para operar desde otra máquina autorizada use un túnel SSH local al puerto 13400. Seleccione integration-5m y confirme el recorrido institucional en el panel. El proceso verifica los propietarios de los listeners de API (13104), orquestador (13304) y PostgreSQL (55436) mediante un socket Unix restringido, y comprueba la revisión, las marcas de base y el lock exclusivo. Los reportes persisten en /var/lib/sd-lab/reports. Tras una interrupción inesperada, investigue cualquier lock residual y los procesos del cgroup antes de liberarlo manualmente. El apagado deja PostgreSQL disponible. Para una parada de mantenimiento del clúster dedicado use `sudo systemctl stop postgresql@18-simlab`. k6, telemetría CIM y los demás escenarios pertenecen al despliegue Windows en esta fase.
