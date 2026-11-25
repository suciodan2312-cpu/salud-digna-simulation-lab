export class ContractError extends Error {
  constructor(field: string) { super(`Respuesta incompatible (${field})`); }
}
export class CapabilityError extends Error {
  constructor(capability: string) { super(`Capacidad no disponible (${capability})`); }
}
export type RequestId = string & { readonly kind: 'RequestId' };
export type JourneyId = string & { readonly kind: 'JourneyId' };
export type Role = 'PATIENT' | 'ADVISOR' | 'ADMIN';
export type Channel = 'web' | 'whatsapp' | 'call-center';
export type Status = 'DRAFT' | 'IN_PROGRESS' | 'PENDING_CONFIRMATION' | 'COMPLETED' | 'CANCELLED';
export type Decoder<T> = (raw: unknown) => T;

export function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ContractError('objeto');
  return raw as Record<string, unknown>;
}
export function string(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) throw new ContractError('texto');
  return raw;
}
export function literal<const T extends readonly string[]>(raw: unknown, ...values: T): T[number] {
  const value = string(raw);
  if (!values.includes(value)) throw new ContractError('enum');
  return value;
}
export const status = (raw: unknown): Status =>
  literal(raw, 'DRAFT', 'IN_PROGRESS', 'PENDING_CONFIRMATION', 'COMPLETED', 'CANCELLED');
export function uuid(raw: unknown): string {
  const value = string(raw);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new ContractError('UUID');
  return value;
}
export const requestId = (raw: unknown) => uuid(raw) as RequestId;
export const journeyId = (raw: unknown) => uuid(raw) as JourneyId;
export function integer(raw: unknown, min = 0): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min) throw new ContractError('entero');
  return raw;
}
export function boolean(raw: unknown): boolean {
  if (typeof raw !== 'boolean') throw new ContractError('booleano');
  return raw;
}
export function timestamp(raw: unknown): string {
  const value = string(raw);
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new ContractError('fecha ISO 8601');
  }
  return value;
}
export function list<T>(raw: unknown, decode: Decoder<T>): T[] {
  if (!Array.isArray(raw)) throw new ContractError('lista');
  return raw.map(decode);
}
export function page<T>(raw: unknown, decode: Decoder<T>) {
  const row = object(raw);
  return { items: list(row.items, decode), page: integer(row.page, 1),
    limit: integer(row.limit, 1), hasMore: boolean(row.hasMore) };
}
export function requireFresh(expiresAt: string, capability: string) {
  if (Date.parse(expiresAt) <= Date.now()) throw new CapabilityError(capability);
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs?: number) {
    super('HTTP ' + status);
  }
}

export class NetworkError extends Error {
  constructor() { super('Falló la comunicación con el servicio'); }
}
