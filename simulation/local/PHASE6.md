# Demostración HackaTec

Abre http://127.0.0.1:13400 y pulsa **Modo HackaTec**. Los indicadores de COPY salen del journal; las filas generadas se calculan aparte desde los manifiestos. Los laboratorios conservan puertos independientes y las bases anteriores.

1. **Resumen.** Muestra los servicios y el volumen cargado por los laboratorios de 1,200, 100K y 1M.
2. **Centro de control.** Selecciona lecturas de pacientes, el corpus 100K, 5 iteraciones/s, 60 segundos y hasta 5 VUs. Los porcentajes frecuente/citas definen la mezcla. Pulsa **Validar plan**, confirma destino local e inicia solo si el operador autorizó la combinación. Durante la prueba, el panel muestra puntos emitidos por k6. Puedes detener el proceso y conservar el resultado parcial.
3. **Rendimiento e historial.** Compara el escalón y el dataset de cada ejecución. Muestra la prueba detenida de 25 iteraciones/s como límite encontrado con la configuración probada. La evidencia incluye reportes completos, parciales y fallidos.
4. **Pacientes virtuales.** Selecciona **Atención asistida**. Esa reproducción histórica acredita el canje y la recuperación del contexto con el asesor. El indicador sintético bajó de 95 a 45 tras el éxito. El reporte de roles acredita una cita asistida confirmada en un recorrido separado.
5. **Comportamiento individual.** En la mezcla puedes configurar siete perfiles, semilla, espera y frustración. Se elige un actor por plan reproducible y se registra el perfil observado. El escenario de capacidad solo admite las dos lecturas. Resultados clínicos permanece deshabilitado. WhatsApp externo permanece desactivado.

## Arranque

Desde `simulation/`:

    corepack pnpm check
    corepack pnpm build
    corepack pnpm test
    cd lab-ui
    corepack pnpm check
    corepack pnpm test
    corepack pnpm build
    $env:SIM_LAB_ALLOWED_PLANS='5:60:5,behavior:60:1'
    corepack pnpm start

El servidor escucha en 127.0.0.1; la lista anterior requiere autorización del operador antes de ejecutar. `1m:5:60:5` corresponde al laboratorio 1M. Editar una mezcla de capacidad no permite incluir operaciones de asistencia o continuidad. Para repetir la atención asistida usando las cuentas existentes, desde simulation/ ejecutar `powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\local\staff.ps1 -Id roles-fase6 -DemonstrateFrustration` y escribir las credenciales ficticias únicamente en las entradas sin eco. Los reportes anteriores se conservan.

## Datos y siguiente escala

El corpus 1M se generó con semilla 42. Los laboratorios se distinguen por PostgreSQL/API/orquestador: 55432/13100/13300 (inicial), 55433/13101/13301 (100K), 55434/13102/13302 (1M). La generación, COPY y k6 conservan sus procesos independientes.

Para una futura validación 5M, verificar disco, memoria disponible, capacidad de WAL, migraciones y un clúster nuevo. Con autorización, desde simulation/ usar `$env:SIM_RECORDS='5000000'`, `corepack pnpm start dataset-generate`, `corepack pnpm start dataset-validate <id>` y `corepack pnpm start copy-plan <id>`. Cargar únicamente después de un preflight del destino dedicado y otra autorización. La estimación del archivo COPY es de ~1.02 GB a partir de 203.6 MB para 1M. No proyectar consumo de RAM como función lineal de filas: el generador y el cargador acotan buffers/lotes, mientras que PostgreSQL usa caché y WAL que deben medirse.

## Límites y publicación

El tráfico remoto queda deshabilitado. Para un entorno de pruebas autorizado, pedir al equipo el SHA, OpenAPI y revisión del orquestador, comparar con `compare-contracts <archivo-local.json>`, revisar TLS, scopes, permisos, caducidad y límites. El portal, Call Center, Administración y los dos backends mantienen sus URLs independientes. No conectar el servidor público.

Para un futuro commit, incluir exclusivamente código/configuración y lockfiles en `simulation/`, sus pruebas y README, y `docs/simulation-engine.md`. Consultar la lista exacta con `git ls-files --others --exclude-standard -- simulation docs/simulation-engine.md`. Los archivos de reportes que implementan formato/comparación son código fuente. Clústeres, binarios, `node_modules`, compilados, logs, reportes y datasets son artefactos locales.

## Cierre de la demo

Desde el worktree: cd simulation/lab-ui, configurar $env:SIM_LAB_ALLOWED_PLANS='5:60:5,behavior:60:1' y ejecutar corepack pnpm start. Abrir http://127.0.0.1:13400. Seleccionar 100K, 5 iteraciones/s, 60 s y 5 VUs, validar y confirmar para iniciar. Usar Detener esta prueba y esperar la confirmación antes de cerrar Next con Ctrl+C. Los laboratorios quedan separados del panel. Para habilitar una lectura sobre 5M, confirmar primero COPY y la revisión local, y agregar solo el plan autorizado, por ejemplo 5m:5:30:5.
