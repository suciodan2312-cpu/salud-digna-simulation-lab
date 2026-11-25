import { isAbsolute, join } from 'node:path';

// Only commands that inspect the external checkout need this setting.
export function serviceSource(...parts: string[]) {
  const root = process.env.SIM_SERVICES_REPO;
  if (!root || !isAbsolute(root)) {
    throw new Error('Configure SIM_SERVICES_REPO con la ruta absoluta del repositorio local de servicios.');
  }
  return join(root, ...parts);
}
