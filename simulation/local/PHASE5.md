# Fase 5

- Laboratorio original en 55432/13100/13300. Laboratorio nuevo de 100K en 55433/13101/13301. Ambos restringidos a 127.0.0.1. Nuevo laboratorio preparado con `local/prepare.ps1 -ApproveNewLocalLab -LargeCorpus -AllowRegistry` tras autorización. Los roles y contraseñas de sus bases son independientes.
- Para el operador, la validación con cuentas existentes y el recorrido de atención del paciente frustrado se ejecutan en `simulation/` mediante `powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\local\staff.ps1 -Id roles-01 -DemonstrateFrustration`. El script usa el laboratorio original y solicita ambas contraseñas sin eco. Confirma primero que la ejecución esté autorizada. Los resultados de recuperación se muestran como atención únicamente si el asesor canjea la referencia y recupera el contexto.
- COPY confirmado para `ceadf10e490e4791b1168eb9`. Para inspeccionar la configuración sin tráfico, ejecutar `corepack pnpm start copy-plan ceadf10e490e4791b1168eb9`. Los reportes de COPY capturan los conteos y la evidencia posterior. La preparación de cuentas activas es posterior a esa auditoría.
- La ejecución de referencia se preparó con 5 iteraciones/s, 60 s y hasta 5 VUs. Los otros niveles se preparan con `SIM_RATE=10|25|50|100`, `SIM_DURATION_SECONDS=60` y `corepack pnpm start k6-plan habitual`. El runner y la UI exigen la aprobación exacta del plan antes de correr. Los umbrales son p95 ≤500 ms, errores <1%, sin descartes; al finalizar se verifica la integridad. Las lecturas del paciente son una mezcla de próximas citas y solicitudes pendientes.
- Artefactos completos de referencia `reports/k6-phase5-reference-05.json`, `.csv`, `reports/phase5-reference-05.html` y `reports/phase5-reference-05-resources.json`. El panel presenta la comparación con el laboratorio anterior. La medición no acredita capacidad prolongada.

## Generación futura

Desde simulation/:

    $env:SIM_SEED='42'
    $env:SIM_RECORDS='1000000' # Para la escala siguiente: 5000000
    corepack pnpm start dataset-generate
    corepack pnpm start dataset-validate <id>
    corepack pnpm start copy-plan <id>

Las 100,000 filas produjeron 20.34 MB de archivos. La proyección lineal del texto COPY es de ~203 MB para 1 millón y ~1.02 GB para 5 millones. Las dos bases del corpus 100K ocupan 45.8 MB, incluyendo el tamaño inicial de ambas. Descontando como referencia los ~18.9 MB de las bases pequeñas, la proyección combinada de almacenamiento activo es de ~288 MB y ~1.36 GB, respectivamente. Las estimaciones excluyen WAL, copias de seguridad e índices adicionales; el uso real depende de la distribución de entidades y PostgreSQL. Confirmar recursos y autorizaciones por etapa.
