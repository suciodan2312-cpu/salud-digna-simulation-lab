# Salud Digna Simulation Lab

Laboratorio de simulación omnicanal para el HackaTec Nacional. Permite observar cómo pacientes sintéticos consultan solicitudes, continúan un trámite en otro canal o piden asistencia humana. Separa el tamaño del corpus histórico, las identidades autenticadas y la carga HTTP ofrecida.

## Arquitectura

| Componente | Función |
| --- | --- |
| [Motor TypeScript](simulation/README.md) | Perfiles reproducibles, escenarios concurrentes y adaptadores HTTP independientes para la API central y el orquestador. |
| [Datos y carga](simulation/data) | Generación con Faker.js por streaming, manifiestos y carga por servicio mediante PostgreSQL COPY. |
| [Rendimiento](simulation/load/README.md) | Escenarios de Grafana k6, límites de ejecución, métricas y exportación de resultados. |
| [Panel local](simulation/lab-ui/README.md) | Next.js y React para configurar planes, solicitar inicio o detención y consultar métricas y recorridos disponibles. |
| [Despliegue Debian](docs/simulation-linux.md) | Unidades systemd y restauración lógica en un clúster PostgreSQL 18 sintético y dedicado. |

## Instalación y primer uso

Requiere Node.js 24 y pnpm 11.28.11. Los dos paquetes tienen lockfiles independientes. Desde la raíz:

```sh
cd simulation
corepack pnpm install --frozen-lockfile
corepack pnpm build
node dist/cli.js check-config
cd lab-ui
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm start
```

Abra **http://127.0.0.1:13400**. Detenga el panel con Ctrl+C. En una instalación nueva, el historial está vacío y el panel inicia en modo consulta. La generación de datos, la restauración de bases y la ejecución de escenarios son acciones independientes.

## Servicios y configuración externa

Para compilar ambos paquetes basta este repositorio. Para operaciones reales se necesitan instancias aisladas de los servicios compatibles y cuentas sintéticas con el rol adecuado. Las rutas y controles de loopback se conservan. Las fuentes externas solo se necesitan para revisión estática de contratos, comparación OpenAPI, comprobación de migraciones en COPY y preparación privada de servicios. Configure **SIM_SERVICES_REPO** con la ruta absoluta de una copia local autorizada:

```powershell
$env:SIM_SERVICES_REPO = 'D:\laboratorios\servicios'
```

```sh
export SIM_SERVICES_REPO=/srv/privado/servicios
```

Use el checkout de la revisión cuyo contrato se quiere verificar. El esquema histórico corresponde a `ff989cc` y el laboratorio de recuperación institucional utiliza los servicios de `bff1f58`. Los comandos de preparación leen estas revisiones del Git externo. La ubicación privada se configura en el entorno de ejecución. Consulte la [configuración de ejemplo](simulation/.env.example) y la [guía de Windows](simulation/local/README.md). Los scripts de k6 necesitan un binario local compatible. Los datasets, cuentas, reportes y servicios se aprovisionan por separado.

## Evidencia y límites

En el laboratorio Windows de origen se cargaron y auditaron **5 millones de filas** y se validó una simulación con **10 pacientes**. En el escalón de **50 iteraciones/s durante 30 segundos**, la latencia p95 fue de **8.86 ms**. El escalón de 100 iteraciones/s se detuvo al registrar 12 descartes. Estas mediciones describen ese laboratorio y esa duración. Los reportes privados permanecen en origen.

En Debian 13 se ha preparado el panel y el recorrido institucional con Node.js 24, PostgreSQL 18 y systemd. Su restauración y ejecución completa requieren validación en un host Debian. La consulta de resultados clínicos permanece deshabilitada hasta contar con un contrato verificable.
