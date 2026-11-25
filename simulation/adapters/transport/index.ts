import { setTimeout as sleep } from 'node:timers/promises';
import { isLoopback, type Config } from '../../config/index.js';
import { CapabilityError, ContractError, HttpError, NetworkError, type Decoder } from '../../contracts/index.js';

export interface Request {
  operation: string;
  path: string;
  method?: 'GET' | 'POST' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  expected?: number;
  writes?: boolean;
  safeRetry?: boolean;
}
export interface Transport {
  send<T>(request: Request, decode: Decoder<T>): Promise<T>;
}
export type Observation = { operation: string; status: number; elapsedMs: number };
export { HttpError, NetworkError } from '../../contracts/index.js';

function retryAfter(value: string | null, now: number) {
  if (value === null) return undefined;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

export class HttpTransport implements Transport {
  private active = 0;
  constructor(private readonly origin: string, private readonly config: Config,
    private readonly observe: (sample: Observation) => void = () => {},
    private readonly fetcher: typeof fetch = fetch) {}

  async send<T>(request: Request, decode: Decoder<T>): Promise<T> {
    const method = request.method ?? 'GET';
    if (this.config.environment !== 'local' || !isLoopback(this.origin)) {
      throw new CapabilityError('HTTP habilitado exclusivamente en loopback durante esta fase');
    }
    if ((method !== 'GET' || request.writes) && !this.config.allowWrites) {
      throw new CapabilityError('escrituras locales con SIM_ALLOW_WRITES');
    }
    if (this.active >= this.config.concurrency) throw new CapabilityError('límite local de concurrencia');
    this.active++;
    try {
      for (let attempt = 0; ; attempt++) {
        try { return await this.once(request, decode); } catch (error) {
          const transient = error instanceof NetworkError ||
            (error instanceof HttpError && [429, 502, 503, 504].includes(error.status));
          if (method !== 'GET' || request.writes || !request.safeRetry || !transient ||
              attempt >= this.config.retries) throw error;
          const delay = error instanceof HttpError && error.retryAfterMs !== undefined
            ? error.retryAfterMs : 250 * (attempt + 1);
          if (delay > this.config.maxRetryAfterMs) throw error;
          await sleep(delay);
        }
      }
    } finally { this.active--; }
  }

  private async once<T>(request: Request, decode: Decoder<T>) {
    const start = performance.now();
    let status = 0;
    try {
      const url = new URL(request.path, this.origin);
      if (url.origin !== this.origin || !url.pathname.startsWith('/api/v1/')) {
        throw new CapabilityError('ruta de transporte');
      }
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: request.method ?? 'GET', redirect: 'error', cache: 'no-store',
          signal: AbortSignal.timeout(this.config.timeoutMs),
          headers: { accept: 'application/json', ...request.headers,
            ...(request.body === undefined ? {} : { 'content-type': 'application/json' }) },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
        });
      } catch { throw new NetworkError(); }
      status = response.status;
      if (status !== (request.expected ?? 200)) {
        await response.body?.cancel().catch(() => {});
        if (response.ok) throw new ContractError('estado HTTP');
        throw new HttpError(status, retryAfter(response.headers.get('retry-after'), Date.now()));
      }
      let value: unknown;
      try { value = await response.json(); } catch { throw new ContractError('JSON'); }
      return decode(value);
    } finally { this.observe({ operation: request.operation, status, elapsedMs: performance.now() - start }); }
  }
}
