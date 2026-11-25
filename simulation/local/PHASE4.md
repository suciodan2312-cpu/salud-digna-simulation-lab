# Fase 4 — validación local

## Cuentas oficiales

Desde la raíz del simulador, en PowerShell:

    Set-Location '.\simulation\reports\local-lab-ff989cc-4\runtime\apps\api'
    Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
    node dist/auth/create-advisor.js
    node dist/auth/create-admin.js

En CMD:

    cd /d ".\simulation\reports\local-lab-ff989cc-4\runtime\apps\api"
    set "DATABASE_URL="
    node dist/auth/create-advisor.js
    node dist/auth/create-admin.js

Usar `advisor-fase4@example.test` y `admin-fase4@example.test`. La CLI oficial solicita contraseña y confirmación sin eco. No uses credenciales del equipo. Desde `simulation/`, tras el aprovisionamiento y la autorización de las comprobaciones locales:

    powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\local\staff.ps1 -Id roles-01

El wrapper solicita ambas contraseñas en privado y genera un reporte sin sesiones, datos personales ni códigos. Comprueba identidad por rol, rechazos 401/403, confirmación asistida y administración. La política se aplica al proceso hijo.

## Frustración

`SIM_FRUSTRATION_INITIAL=0..100`. Modo `observed` reacciona a las operaciones. Modo `initial` empieza con una inconformidad sintética y puede solicitar una referencia real. Por ejemplo, desde simulation/ y con autorización de escritura local:

    $env:SIM_FRUSTRATION_MODE='initial'
    $env:SIM_FRUSTRATION_INITIAL='95'
    $env:SIM_ALLOW_WRITES='true'
    $lab='reports/local-lab-ff989cc-4'
    node "--env-file=$lab/simulation.env" "--env-file=$lab/actors.env" dist/cli.js profile frustrado

Una referencia emitida significa ayuda solicitada. La recuperación humana exige canje y lectura de la solicitud por un asesor autenticado. Los eventos se marcan como observados, sintéticos o inyectados. El score no es un indicador clínico ni una medición de satisfacción real.

## Medición y control

    $lab='reports/local-lab-ff989cc-4'
    node "--env-file=$lab/simulation.env" "--env-file=$lab/actors.env" dist/local/baseline.js preflight
    # Requiere autorización explícita para este ensayo exacto.
    $env:SIM_BASELINE_APPROVAL='read-five-for-thirty'
    node "--env-file=$lab/simulation.env" "--env-file=$lab/actors.env" dist/local/baseline.js run reads-01
    node dist/reports/compare.js reads-01

El runner permite únicamente 5 iteraciones/s durante 30 s y el laboratorio conocido. Usa la sesión ficticia adquirida fuera de k6. Mide lecturas autenticadas de próximas citas y solicitudes pendientes. Valida PIDs/puertos, marcas, journal, salud y caducidad. Ctrl+C detiene el hijo k6 sin detener los servicios. El estado de integridad compara conteos de tablas antes y después. Los contadores de PostgreSQL incluyen la actividad del recolector. CPU se registra como tiempo acumulado de cada grupo de procesos, y memoria como RSS. PostgreSQL agrega el proceso raíz y descendientes. Un proceso ya terminado o una métrica para la que el rol carece de acceso aparece como no disponible.

Los archivos `k6-phase4-<id>.json/.csv`, `phase4-<id>.html` y `phase4-<id>-resources.json` conservan la ejecución. El comparativo contrasta este ensayo y el smoke real, marcando métricas ausentes. Las pruebas funcionales y el fixture offline tienen archivos separados. Un ensayo de 30 segundos describe ese intervalo, no la capacidad sostenible a largo plazo.

Para preparar escalones sin ejecutarlos, configura `SIM_RATE` en 5, 10, 25, 50 o 100, `SIM_DURATION_SECONDS` en la duración de meseta y ejecuta `corepack pnpm start k6-plan habitual`. Define antes de cada autorización el conjunto de operaciones y el corpus. Umbrales iniciales de revisión: p95 ≤ 500 ms, errores inesperados <1%, sin descartes sostenidos, presión de recursos aceptable y conteos de negocio coherentes. Cada incremento requiere autorización. La siguiente mezcla autorizada debe escoger explícitamente lecturas públicas, pacientes o administración. Los canjes y escrituras tienen recorridos separados.

## Corpus

Para generar offline otros tamaños, desde simulation/:

    $env:SIM_SEED='42'
    $env:SIM_RECORDS='500000' # Alternativas: 1000000, 5000000
    corepack pnpm start dataset-generate
    corepack pnpm start dataset-validate <id>
    corepack pnpm start copy-plan <id>

Para cargar un corpus mayor se necesita autorización específica para un laboratorio nuevo con sus bases vacías, marca sintética, roles y migraciones. Usar otro directorio y puertos después de revisar el plan, ajustar explícitamente el runner aprobado y conservar los archivos y bases del laboratorio actual. La generación offline no modifica bases.

La interfaz interna en `local/control.ts` tipa estados, eventos e historial para una futura UI. El ejecutor disponible es el runner local con un escenario y destinos fijos. No acepta rutas, shell ni comandos desde una interfaz.
