export const labPlan = {
  base: 'ff989ccd6e1062a5508e8f92cefbf17b7830896b',
  loopback: '127.0.0.1',
  ports: { postgres: 55432, central: 13100, orchestrator: 13300 },
  databases: { central: 'salud_digna_simulation', orchestrator: 'salud_digna_orchestrator' },
  marker: 'salud-digna:synthetic-only',
  integrations: { whatsapp: false, openai: false },
  corpus: '3ec1448fee9783a2150ccefc',
  actions: ['compilar una copia de ff989cc', 'inicializar un clúster PostgreSQL nuevo y privado',
    'aplicar migraciones auditadas a bases nuevas', 'verificar esquemas y cargar solo con autorización separada',
    'aprovisionar cuentas ficticias mediante contratos y CLI oficiales', 'iniciar servicios en loopback'],
} as const;
