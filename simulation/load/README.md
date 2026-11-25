# Grafana k6

Requiere un binario oficial de k6 en PATH. En Windows se puede usar una distribución portátil de Grafana y agregarla temporalmente al PATH de la sesión. Instala el paquete del simulador y compila primero. El script ejecutable es `dist/load/main.js`, que comparte los adaptadores y escenarios compilados sin importar módulos de Node.

Planifica desde `simulation/` con `corepack pnpm start k6-plan <escenario>`. Para una futura ejecución autorizada, define las variables en la sesión de PowerShell y ejecuta `k6 run dist/load/main.js`. Configura `SIM_ENV=local` y `SIM_K6_CONFIRM=isolated-loopback` para autorizar el runner. Los escenarios que escriben requieren además `SIM_ALLOW_WRITES=true`. Usa URLs HTTP o HTTPS con dirección literal loopback. Los JWT para escenarios autenticados se preparan previamente con su caducidad y se entregan por variables de entorno. k6 no inicia sesiones en el tramo medido.

| Escenarios | Ejecutor |
| --- | --- |
| `smoke` | Una iteración de salud y catálogo. |
| `habitual`, `soak`, `admin` | Tasa constante. Administración consulta indicadores con JWT preemitido. |
| `progressive`, `peak`, `spike`, `saturation` | Rampas limitadas por la tasa y VUs configurados. |
| `independent` | Una solicitud y cita por VU. |
| `version-conflict`, `idempotency`, `continuity`, `frustrated` | Una iteración con un VU. Las capacidades de continuidad y conversación requieren sus banderas. |

`SIM_RATE` acepta objetivos como 10, 25, 50, 100, 250, 500 y 1,000 iteraciones/s. `SIM_PRE_VUS`, `SIM_VUS`, `SIM_DURATION_SECONDS`, `SIM_RAMP_SECONDS`, `SIM_STUDY_PERCENT`, `SIM_PATIENT_READ_PERCENT`, `SIM_CITAS_PERCENT`, `SIM_P95_MS`, `SIM_ERROR_PERCENT`, `SIM_MAX_DROPPED` y `SIM_STOP_DELAY_SECONDS` ajustan el plan. Por defecto, la mezcla de capacidad usa catálogo público. Si habilitas lecturas de pacientes, usa un JWT de prueba preparado previamente. Ningún nivel se ha validado como capacidad sostenible.

Los reportes agregados salen en `reports/k6-<escenario>.json` y `.csv`. Usa `SIM_CODE_REVISION` para identificar el código y `SIM_DATASET_ID` para el corpus presente. Configura `K6_WEB_DASHBOARD=true` y `K6_WEB_DASHBOARD_EXPORT=reports/k6-dashboard.html` al ejecutar una versión compatible. El dashboard enlaza a localhost por defecto. Consulta la [documentación de Grafana](https://grafana.com/docs/k6/latest/results-output/web-dashboard/).
