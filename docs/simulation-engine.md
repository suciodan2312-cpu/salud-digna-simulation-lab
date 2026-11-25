## Segunda fase

- El corpus histórico se genera con Faker.js y una fecha de referencia explícita. Los archivos de texto COPY usan buffers acotados por tabla, se identifican por semilla, versión, fecha, SHA y volumen, y se verifican byte a byte mediante SHA-256 contra el generador determinista. Un manifiesto terminado permite reutilizar los archivos. Los usuarios del corpus carecen de credenciales. No hay correspondencia entre pacientes, sujetos, solicitudes y trámites de servicios distintos.
- COPY carga tablas en orden de dependencia en una transacción por servicio, sin alterar restricciones. Ambas conexiones pasan la revisión de entorno, migraciones, columnas y vaciedad antes de transferir filas. Cada lote es provisional hasta el commit. El journal exclusivo impide repetir una operación cuyo resultado podría ser incierto. Un fallo entre commits puede dejar solo un servicio cargado. Resolver manualmente el estado de ambas bases antes de repetir. La revisión de esquema usa los nombres y checksums de las migraciones auditadas y las columnas obligatorias. Las restricciones del PostgreSQL real se comprueban durante COPY.
- Los perfiles ejecutables conservan objetivo, canal, pausas y estado en memoria. Frustración usa respuestas, tiempo y conflictos observados y etiqueta aparte los eventos introducidos por el simulador. Los reintentos de un avance versionado se permiten solo tras un rechazo inequívoco y una relectura. Agendamiento y continuidad siguen separados.
- El runner de k6 importa código común compilado, sin módulos de Node. Los perfiles de capacidad son configuraciones acotadas. Las escrituras de conflicto, idempotencia, continuidad y frustración de k6 son de una iteración. La mezcla de capacidad admite catálogos y lecturas de citas/solicitudes con una sesión preaprovisionada. La adquisición de JWT se queda fuera de k6. La distribución entre múltiples cuentas distintas queda pendiente de un mecanismo de aprovisionamiento y vigencia de sesiones.
- Los reportes JSON y CSV identifican el escenario, semilla, versión de código, dataset y entorno. Se exportan estadísticas numéricas agregadas sin etiquetas de alta cardinalidad ni cuerpos HTTP. Solo se generan indicadores observados y variables sintéticas identificadas. Los reportes no son mediciones de esta implementación hasta que se ejecute una prueba real autorizada.

## Pendientes operativos

Verificar COPY primero en dos bases desechables y luego aprovisionar cuentas y credenciales activas. Instalar el binario portátil de k6 y validar su carga de módulos con una inspección offline antes de cualquier smoke. Los destinos remotos de pruebas requieren revisar la revisión desplegada y autorizar explícitamente su acceso. Siguen pendientes los resultados clínicos, la identidad central firmada, la renovación de grants y la confirmación de una cita central desde el orquestador.

## Fase 3

El [laboratorio aislado](../simulation/local/README.md) prepara una copia auditada, separa la autorización de COPY y smoke, y mantiene fuera de Git datos, binarios y credenciales.

## Fase 4

La [guía operativa](../simulation/local/PHASE4.md) describe el ensayo local fijo, los reportes comparativos, el monitoreo Windows y PostgreSQL, y la validación interactiva de roles.

## Fase 5

El [laboratorio 100K](../simulation/local/PHASE5.md) conserva el laboratorio de referencia. El [centro de control visual](../simulation/lab-ui/README.md) consulta reportes reales y ejecuta únicamente configuraciones locales previamente autorizadas.

## Fase 6

El [guion HackaTec](../simulation/local/PHASE6.md) documenta la mezcla configurable, los tres corpus y las comprobaciones de tráfico y versionado.

## Respaldo y ensayos sostenidos del corpus 5M

El manifiesto reproducible usa la semilla 42, fecha de referencia `2026-11-24T00:00:00.000Z` y esquemas de `ff989cc`. El corpus es `83c9d0aa989ec6d1d2ea1e17`. Los archivos y clústeres permanecen fuera de Git. Para reconstruirlo en otra máquina autorizada, ejecutar desde `simulation/` el comando `corepack pnpm start dataset-generate` con `SIM_RECORDS=5000000` y `SIM_SEED=42`. Usar el procedimiento de [preparación local](../simulation/local/README.md) con `-FiveMillionCorpus`, bases vacías, preflight, COPY autorizado y auditoría antes de aprovisionar cuentas. Para consultar resultados en este equipo basta con abrir el historial del panel local.

Para repetir **un** escalón con autorización vigente, ejecutar desde `simulation/` en PowerShell. Elegir un identificador nuevo. Los planes de esta fase son `25:300:10`, `50:300:20` y `100:120:20` (iteraciones/s, segundos y VUs). Revisar el informe de cada escalón antes de incrementar.

```powershell
$env:SIM_LOCAL_LAB='corpus-5m'
$env:SIM_PHASE7='true'
$env:SIM_BASELINE_APPROVAL='25:300:10'
$env:SIM_STAGE_RATE,$env:SIM_STAGE_SECONDS,$env:SIM_STAGE_VUS=$env:SIM_BASELINE_APPROVAL.Split(':')
$env:SIM_STAGE_SEED='42'
$env:SIM_STAGE_CITAS='50'
node --env-file=reports/local-lab-ff989cc-5m-1/simulation.env --env-file=reports/local-lab-ff989cc-5m-1/actors.env dist/local/baseline.js run sostenida-01
```

El runner reserva de entrada el máximo de VUs de ese plan. La traza previa de 100/s concentró los 12 descartes en los primeros 354 ms observados. El primer muestreo pesado de procesos espera 1,5 s. Los límites de k6 y las comprobaciones de recursos siguen activos. Los reportes JSON y CSV de k6, el HTML, la traza y las muestras de recursos quedan bajo `simulation/reports/`.

### Grupos funcionales locales

En [Simulation Lab](http://127.0.0.1:13400), abrir **Centro de control → Pacientes concurrentes**. Operación cotidiana admite hasta 25 identidades a 10 HTTP/s y Alta demanda hasta 50 a 25 HTTP/s en el laboratorio 5M. Atención y continuidad admite hasta 10 identidades a 10 HTTP/s en el laboratorio original. Los topes se comparten entre actores. La duración predeterminada es 120 s, con una comprobación opcional de 8 s. Cada paciente usa su propia sesión y la cantidad efectiva depende de las cuentas preparadas con cita vigente. El runner informa por separado los logins y las peticiones de operación.

Desde `simulation/`, para preparar o renovar cuentas del 5M por la API oficial:

```powershell
$env:SIM_LOCAL_LAB='corpus-5m'
$env:SIM_ACTOR_APPROVAL='synthetic-patients'
$lab='reports/local-lab-ff989cc-5m-1'
node "--env-file=$lab/simulation.env" "--env-file=$lab/actors.env" dist/local/actors.js cohort 3
```

El número final es el objetivo total del laboratorio. Para ampliarlo, cambiarlo hasta 50 y avanzar en lotes manuales de hasta tres verificaciones. Ante HTTP 429, esperar el `Retry-After` informado. En atención, elegir `baseline`, carpeta `reports/local-lab-ff989cc-4` y un objetivo de hasta 10. Los pacientes se validan con una solicitud pendiente, cita próxima y evento real de confirmación. Una reserva con resultado incierto requiere reconciliar el login oficial antes de continuar.

Para iniciar el panel desde `simulation/lab-ui/`, agregar `cohort:cotidiana,cohort:demanda,cohort:atencion` a `SIM_LAB_ALLOWED_PLANS` y ejecutar `corepack pnpm start`. Cada inicio requiere confirmación. El botón de detención y el candado son compartidos con los runners existentes. Los resúmenes funcionales se conservan en `simulation/reports/cohort-<id>.json`.

Atención solicita como máximo una referencia de asistencia y ejecuta un trámite independiente con dos traspasos de canal por corrida. Para incluir al asesor y al administrador existentes desde terminal, usar `powershell -NoProfile -File .\local\staff.ps1 -Id atencion-01 -Cohort` desde `simulation/` y escribir las contraseñas en los campos sin eco. Usar un ID nuevo cada vez. Para operación desde el panel se pueden configurar hasta cuatro cuentas oficiales en `cohort-staff.jsonl` dentro de la carpeta privada del laboratorio original, con un objeto por línea y campos `role`, `email`, `password`. El runner valida cada rol con el login oficial, elige un asesor por corrida y ejecuta una consulta por administrador. Sin credenciales de personal, el reporte distingue la referencia emitida de la atención realizada.

### Propuesta institucional previa

Asignar una identidad ficticia por actor concurrente. Aprovisionar sesiones mediante el login oficial antes de medir y preparar solicitudes y citas propias para cada paciente. Medir por separado lecturas, escrituras versionadas y consultas de ADMIN. Usar una cola en memoria de solicitudes independientes para el canje por ADVISOR, recuperación del contexto y confirmación asistida. Registrar conflictos y caducidad sin reintentar escrituras ambiguas. En el orquestador, ejecutar un flujo de baja frecuencia con sus propios canales, eventos idempotentes y grants. Conservar `requestId` y `journeyId` independientes y etiquetar por rol, operación e identidad sintética agregada.

### Recuperación institucional opcional

En el Centro de control, **Pacientes concurrentes → integration-5m · Recuperación institucional** ejecuta un único recorrido Web → WhatsApp con el mismo paciente del clon. El servidor debe autorizar `cohort:institucional`. Los grupos anteriores conservan sus destinos. El emisor firma acreditaciones de canal con Ed25519 y el orquestador usa la clave pública del laboratorio. Las credenciales del emisor y las claves API de canal son independientes y permanecen en la carpeta privada. La CLI del recorrido es `dist/local/institutional.js <id>`, con `SIM_LOCAL_LAB=integration-5m`, `SIM_COHORT_APPROVAL=institucional` y los archivos privados `simulation.env`, `actors.env` e `institution.env` del clon. Un destinatario ADVISOR requiere consentimiento del paciente para su usuario y canal. El panel usa dos canales PATIENT.
