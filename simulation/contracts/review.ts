import { readFile } from 'node:fs/promises';
import { object } from './index.js';
import { serviceSource } from '../config/service-source.js';
import { schemaSha } from '../data/corpus.js';

const centralRoutes = {
  '/health': ['get'], '/health/db': ['get'], '/auth/register': ['post'], '/auth/login': ['post'], '/auth/me': ['get'],
  '/clinics': ['get'], '/studies': ['get'], '/requests': ['get', 'post'], '/requests/pending': ['get'],
  '/requests/{id}': ['get'], '/requests/{id}/context': ['patch'], '/requests/{id}/pause': ['post'],
  '/requests/{id}/resume': ['post'], '/requests/{id}/confirm': ['post'], '/requests/{id}/journey': ['get'],
  '/requests/{id}/assistance-code': ['post'], '/call-center/claim': ['post'], '/call-center/requests/{id}': ['get'],
  '/call-center/requests/{id}/confirm': ['post'], '/appointments': ['get'], '/appointments/upcoming': ['get'],
  '/admin/overview': ['get'], '/admin/requests': ['get'], '/admin/requests/{id}/journey': ['get'],
};
export async function reviewContracts() {
  const openApi = object(JSON.parse(await readFile(serviceSource('docs/openapi.json'), 'utf8')) as unknown);
  const paths = object(openApi.paths);
  for (const [path, methods] of Object.entries(centralRoutes)) {
    const route = object(paths['/api/v1' + path]);
    for (const method of methods) object(route[method]);
  }
  const pairs = [
    ['journey-access/continuity-codes.controller.ts', ["@Post('journeys/:journeyId/continuity-codes')", "@Post('continuity-codes/redeem')"]],
    ['journeys/journey-writes.controller.ts', ["@Post('journeys')", "@Post('events')"]],
    ['journeys/journey-queries.controller.ts', ["@Get()", "@Get(':journeyId')", "@Get(':journeyId/context')", "@Get(':journeyId/history')"]],
    ['channel-auth/channel-auth.controller.ts', ["@Get('verify')"]],
    ['health.controller.ts', ["@Get()"]],
  ] as const;
  for (const [file, patterns] of pairs) {
    const source = await readFile(serviceSource('apps/orchestrator/src/', file), 'utf8');
    if (!patterns.every(pattern => source.includes(pattern))) throw new Error('Contrato de orquestador incompatible');
  }
  const conversation = await readFile(serviceSource('apps/api/src/conversations/conversation.controller.ts'), 'utf8');
  if (!conversation.includes("@Post('message')")) throw new Error('Contrato conversacional incompatible');
  return { schemaSha, scope: 'static-routes', centralRoutes: Object.keys(centralRoutes).length,
    orchestratorOperations: pairs.reduce((sum, [, patterns]) => sum + patterns.length, 0),
    conversation: 'development-only', clinicalResults: 'blocked' };
}
