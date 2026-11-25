export const profiles = {
  nuevo: { actor: 'PATIENT', actions: ['catalog', 'register', 'schedule'], weight: 15 },
  frecuente: { actor: 'PATIENT', actions: ['pending', 'resume', 'appointments'], weight: 30 },
  omnicanal: { actor: 'PATIENT', actions: ['continuity'], weight: 5 },
  indeciso: { actor: 'PATIENT', actions: ['schedule', 'pause', 'resume', 'reselect'], weight: 10 },
  frustrado: { actor: 'PATIENT', actions: ['retry', 'switch', 'assist', 'abandon', 'resume'], weight: 10 },
  dificultades: { actor: 'PATIENT', actions: ['help', 'read', 'explicit-selection'], weight: 10 },
  citas: { actor: 'PATIENT', actions: ['appointments'], weight: 10 },
  resultados: { actor: 'PATIENT', actions: [], weight: 0 },
  asesor: { actor: 'ADVISOR', actions: ['claim', 'read', 'confirm'], weight: 10 },
  administrador: { actor: 'ADMIN', actions: ['overview', 'list', 'history'], weight: 10 },
} as const;
export type Profile = keyof typeof profiles;
export const friction = {
  delay: 10, error: 20, conflict: 20, repeated: 20, unresolved: 30, humanResolved: -50,
  startingConcern: 0, denied: 15, reread: 5, contextRecovered: -10,
} as const;
export type Friction = keyof typeof friction;
