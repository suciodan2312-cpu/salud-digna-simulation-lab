export const cohorts = {
  institucional: { title: 'integration-5m · Recuperación institucional', limit: 1, httpRate: 10, lab: 'integration-5m' },
  cotidiana: { title: 'Operación cotidiana', limit: 25, httpRate: 10, lab: 'corpus-5m' },
  demanda: { title: 'Alta demanda', limit: 50, httpRate: 25, lab: 'corpus-5m' },
  atencion: { title: 'Atención y continuidad', limit: 10, httpRate: 10, lab: 'baseline' },
} as const;
export type Cohort = keyof typeof cohorts;
export function cohortPlan(name: unknown, patients?: unknown, seconds: unknown = 120) {
  if (typeof name !== 'string' || !Object.hasOwn(cohorts, name)) throw new Error('Grupo desconocido');
  const preset = name as Cohort;
  const limit = cohorts[preset].limit;
  const size = patients ?? limit;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > limit ||
      typeof seconds !== 'number' || ![8, 120].includes(seconds) || (preset === 'institucional' && seconds !== 120)) throw new Error('Configuración de grupo inválida');
  return { scenario: 'cohort' as const, preset, patients: size, seconds };
}
export type CohortPlan = ReturnType<typeof cohortPlan>;
