export const originalRevision = 'ff989ccd6e1062a5508e8f92cefbf17b7830896b';
export const integrationRevision = 'bff1f5890a6929719a241fe7ed8c40efd4b95860';
export const targets = {
  'integration-5m': { folder: 'reports/local-lab-bff1f58-5m-1', database: 55436, central: 13104, orchestrator: 13304,
    dataset: '83c9d0aa989ec6d1d2ea1e17' },
  baseline: { folder: 'reports/local-lab-ff989cc-4', database: 55432, central: 13100, orchestrator: 13300,
    dataset: '3ec1448fee9783a2150ccefc' },
  'corpus-100k': { folder: 'reports/local-lab-ff989cc-100k-1', database: 55433, central: 13101, orchestrator: 13301,
    dataset: 'ceadf10e490e4791b1168eb9' },
  'corpus-1m': { folder: 'reports/local-lab-ff989cc-1m-1', database: 55434, central: 13102, orchestrator: 13302,
    dataset: '503f4ea4414832b71280a1c5' },
  'corpus-5m': { folder: 'reports/local-lab-ff989cc-5m-1', database: 55435, central: 13103, orchestrator: 13303,
    dataset: '83c9d0aa989ec6d1d2ea1e17' },
} as const;
const chosen = process.env.SIM_LOCAL_LAB ?? 'baseline';
if (chosen !== 'baseline' && chosen !== 'corpus-100k' && chosen !== 'corpus-1m' && chosen !== 'corpus-5m' && chosen !== 'integration-5m') throw new Error('Laboratorio desconocido');
export const localTarget = targets[chosen];
export const stagedTarget = chosen !== 'baseline';

export const serviceRevision = chosen === 'integration-5m' ? integrationRevision : originalRevision;
