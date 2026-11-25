# Salud Digna Simulation Lab

Aplicación independiente Next.js, React y TypeScript. Escucha en `http://127.0.0.1:13400`. Su API local lee manifiestos, commits de COPY, reportes k6 y evidencia funcional del módulo padre. Los binarios, reportes, credenciales y bases permanecen fuera del paquete.

Desde `simulation/`:

    corepack pnpm build
    cd lab-ui
    corepack pnpm install --frozen-lockfile
    corepack pnpm check
    corepack pnpm test
    corepack pnpm build
    corepack pnpm start

El panel inicia en modo consulta. Para autorizar expresamente un plan local exacto en PowerShell, asigna por ejemplo `$env:SIM_LAB_ALLOWED_PLANS='5:60:5'` antes de iniciar Next. La clave representa tasa, duración y máximo de VUs. El operador debe confirmar también en el panel. Cada plan necesita autorización y un laboratorio apropiado con datos y sesiones sintéticas. Los planes de cohortes distinguen identidades autenticadas y usuarios virtuales. En Linux el panel solo admite el recorrido institucional.

`Detener esta prueba` solicita que el runner termine su hijo k6 y conserve muestras y artefactos parciales. Solo puede operar sobre la ejecución que inició el panel. Los indicadores ausentes aparecen como «No disponible». Los porcentajes de frustración pertenecen al recorrido sintético reportado.
