# Simulation Engine

Paquete pnpm independiente. Requiere Node 24 y pnpm 11.28.11. Desde la raíz del worktree:

    cd simulation
    corepack pnpm install --frozen-lockfile
    corepack pnpm check
    corepack pnpm build
    corepack pnpm test

La CLI también se puede ejecutar con `node --env-file=.env dist/cli.js <comando>`. Copia `.env.example` a `.env` para suministrar configuración local. Los comandos se ejecutan desde `simulation/`.

| Comando después de `corepack pnpm start` | Resultado |
| --- | --- |
| `check-config`, `check-contracts` | Validación de configuración y revisión estática de rutas auditadas. |
| `plan`, `frustrated` | Plan offline y ejemplo explícitamente sintético de decisiones. |
| `dataset-generate` | Corpus en `reports/datasets/<id>/`. Usa `SIM_RECORDS`, `SIM_SEED` y `SIM_REFERENCE_DATE`. |
| `dataset-validate <id>` | Regeneración determinista para comprobar conteos, tamaños y SHA-256 de los archivos, sin escribirlos. |
| `copy-plan <id>` | Dry-run offline con las columnas, orden y tamaño de los lotes. |
| `copy-load <id>` | COPY real. Reservado para una operación posteriormente autorizada en bases locales aisladas y etiquetadas. |
| `basic`, `schedule`, `assisted`, `continuity`, `admin`, `version-conflict`, `idempotency`, `appointment-status` | Ejecución funcional sobre instancias locales preparadas. |
| `profile <nombre>` | Una persona ejecuta acciones reales. Admite nuevo, frecuente, omnicanal, indeciso, frustrado, dificultades, citas, asesor y administrador. |
| `k6-plan <escenario>` | Opciones y umbrales de k6 sin requerir el binario. |
| `report <escenario>` | Lee y devuelve únicamente métricas agregadas permitidas del resultado de k6. |

## Corpus y COPY

`SIM_RECORDS` acepta valores de 1 a 5,000,000, incluidos los niveles 10,000, 100,000, 500,000, 1,000,000 y 5,000,000. El objetivo suma filas de ambos servicios. Un corpus pequeño contiene sujetos y pacientes independientes. A partir de 23 filas aparecen grupos históricos completos, catálogos y auditorías. Cada servicio genera su espacio de identificadores. Los usuarios históricos carecen de contraseña. Las cuentas activas y sus solicitudes se aprovisionan después de COPY, por los mecanismos autorizados del repositorio.

`copy-load` exige `SIM_ENV=local`, `SIM_COPY_CONFIRM=salud-digna:synthetic-only`, URLs PostgreSQL independientes y loopback literal. La base central se llama `salud_digna_simulation` y la base del orquestador `salud_digna_orchestrator`, en una instancia PostgreSQL aislada. Un operador autorizado debe identificar las bases con el comentario `salud-digna:synthetic-only` y preparar exactamente las migraciones auditadas antes de invocar el cargador. El cargador comprueba ambas bases y tablas vacías, calcula integridad y registra intentos en `copy-journal.jsonl`. Un journal existente bloquea otra ejecución. Si hay interrupción, reconciliar manualmente ambos servicios y usar un entorno limpio para repetir. Los commits por base son independientes.

## Conectar los servicios

Prepara instancias de la API central y el orquestador en loopback y apunta `SIM_CENTRAL_URL` y `SIM_ORCHESTRATOR_URL` a sus puertos. Usa bases y cuentas exclusivamente ficticias. Mantén `WHATSAPP_ENABLED=false` y `OPENAI_ENABLED=false` en el servidor central. `basic` consulta salud y catálogos. Las demás operaciones funcionales requieren `SIM_ALLOW_WRITES=true` y las cuentas del rol correspondiente. El perfil nuevo registra el correo reservado derivado de la semilla y usa `SIM_PATIENT_PASSWORD`; para repetir el registro en la misma base elige otra semilla. Configura `SIM_CONVERSATION=true` y la aplicación en desarrollo para ejercicios conversacionales.

Para continuidad, define `SIM_CONTINUITY=true` y las credenciales y códigos reales de los tres canales ficticios. Web y WhatsApp requieren ambos scopes. Call Center requiere lectura. El escenario central de citas y el de continuidad operan por separado.

`SIM_ENV=test` permite guardar URLs independientes para planificar. El transporte HTTP y COPY rechazan destinos remotos en esta fase. Para conectarlos posteriormente, revisa el SHA desplegado y su contrato, configura autorización explícita por origen de pruebas y añade comprobaciones de TLS, permisos y aislamiento antes de habilitar tráfico.

Consulta [k6 y dashboard](load/README.md) y [arquitectura](../docs/simulation-engine.md).

Para verificar la fase 3, consulta [el laboratorio local](local/README.md).
