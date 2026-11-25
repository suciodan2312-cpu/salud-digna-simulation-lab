import { cohortPlan } from '../../engine/cohort-plan.ts';
export function validateExecution(input: unknown) {
  if (input && typeof input === 'object' && 'scenario' in input && input.scenario === 'cohort') {
    const { scenario, preset, patients, seconds, ...extra } = input as Record<string, unknown>;
    if (Object.keys(extra).length) throw new Error('Parámetros de grupo desconocidos');
    return cohortPlan(preset, patients, seconds);
  }
  return validatePlan(input);
}
export const origin = 'http://127.0.0.1:13400';
export const legacy = '3ec1448fee9783a2150ccefc';
export const large = 'ceadf10e490e4791b1168eb9';
export const million = '503f4ea4414832b71280a1c5';
export const fiveMillion = '83c9d0aa989ec6d1d2ea1e17';
export const keys = ['nuevo', 'frecuente', 'omnicanal', 'frustrado', 'indeciso', 'dificultades', 'citas'] as const;
export type Mix = Record<typeof keys[number], number>;
export const readMix: Mix = { nuevo: 0, frecuente: 50, omnicanal: 0, frustrado: 0, indeciso: 0, dificultades: 0, citas: 50 };
export const behaviorMix: Mix = { nuevo: 0, frecuente: 0, omnicanal: 0, frustrado: 100, indeciso: 0, dificultades: 0, citas: 0 };
export type Plan = { dataset: string; scenario: 'patient-reads' | 'behavior'; seconds: number; rate: number; vus: number;
  seed: number; initial: number; waitMs: number; mix: Mix };
export function requestAllowed(host: string | null, site: string | null, authority: string | null) {
  return host === '127.0.0.1:13400' && site === 'same-origin' && authority === origin;
}
const range = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
export function validatePlan(input: unknown): Plan {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Configuración inválida');
  const { dataset, scenario, seconds, rate, vus, seed = 42, initial = 95, waitMs = 0, mix = readMix, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length || (scenario !== 'patient-reads' && scenario !== 'behavior') ||
      !range(seed, 0, 0xffffffff) || !range(initial, 0, 100) || !range(waitMs, 0, 5000) ||
      !range(seconds, 1, 600) || !range(rate, 1, 100) || !range(vus, 1, 20) ||
      !mix || typeof mix !== 'object' || Object.keys(mix).length !== keys.length) throw new Error('Configuración fuera de los límites locales');
  const validMix = mix as Mix;
  if (!keys.every(key => range(validMix[key], 0, 100)) ||
      keys.reduce((total, key) => total + validMix[key], 0) !== 100) throw new Error('Los porcentajes deben sumar 100');
  if (scenario === 'behavior') {
    if (dataset !== legacy || rate !== 1 || vus !== 1 || ![30, 60].includes(seconds)) throw new Error('El comportamiento admite un actor a la vez en el laboratorio original');
  } else if ((dataset !== large && dataset !== million && dataset !== fiveMillion) || ![30, 60, 300, 600].includes(seconds) || ![5, 10, 25, 50, 100].includes(rate) ||
      ![2, 5, 10, 20].includes(vus) || validMix.frecuente + validMix.citas !== 100 || waitMs !== 0) {
    throw new Error('La prueba de capacidad solo admite frecuente y citas');
  }
  return { dataset, scenario, seconds, rate, vus, seed, initial, waitMs, mix: validMix };
}
export function approvalKey(plan: Plan) {
  if (plan.scenario === 'behavior') return 'behavior:' + plan.seconds + ':1';
  return (plan.dataset === fiveMillion ? '5m:' : plan.dataset === million ? '1m:' : '') + [plan.rate, plan.seconds, plan.vus].join(':');
}
export function runName(name: string) { return /^(?:smoke|phase[4567]-[a-z0-9][a-z0-9-]{0,47})$/.test(name); }
export function reportFile(name: string) {
  return /^(?:k6-(?:smoke|phase[4567]-[a-z0-9][a-z0-9-]{0,47})\.(?:json|csv)|phase[4567]-[a-z0-9][a-z0-9-]{0,47}\.html)$/.test(name);
}
