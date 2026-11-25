import { isExtraCommand, runExtraCommand } from './commands.js';
import { runProfile } from './engine/behavior.js';
import { profiles, type Profile } from './profiles/index.js';
import { setTimeout as delay } from 'node:timers/promises';
import { CentralApi } from './adapters/central-api/index.js';
import { Orchestrator, type ChannelCredential } from './adapters/orchestrator/index.js';
import { HttpError, HttpTransport, NetworkError } from './adapters/transport/index.js';
import { isLoopback, readConfig } from './config/index.js';
import { CapabilityError, ContractError, type Role } from './contracts/index.js';
import { patientFixtures } from './data/index.js';
import { chooseProfile, seededRandom } from './engine/index.js';
import { FunctionalMetrics } from './monitoring/index.js';
import { admin, basic, continuity, frustrationTrace, idempotency, scenarios, schedule, versionConflict,
  type Scenario } from './scenarios/index.js';

function required(key: string) {
  const value = process.env[key];
  if (!value) throw new CapabilityError(key);
  return value;
}
function credential(channel: ChannelCredential['channel'], prefix: string): ChannelCredential {
  return { channel, key: required(prefix + '_KEY'), expectedCode: required(prefix + '_CODE') };
}
async function main() {
  const config = readConfig();
  const command = process.argv[2] ?? 'plan';
  if (isExtraCommand(command)) return runExtraCommand(command, config);
  if (command === 'profile') {
    const candidate = process.argv[3] ?? chooseProfile(config.weights, seededRandom(config.seed));
    if (!Object.hasOwn(profiles, candidate) || candidate === 'resultados') throw new CapabilityError('perfil disponible');
    const profile = candidate as Profile;
    const omnichannel = profile === 'omnicanal';
    if (config.environment !== 'local' || !isLoopback(config.central) ||
        (omnichannel && (!isLoopback(config.orchestrator) || !config.capabilities.continuity || config.enabledChannels.length !== 3)) ||
        !config.allowWrites || !config.enabledChannels.includes('web') ||
        (profile === 'asesor' && !config.enabledChannels.includes('call-center')) ||
        (profile === 'dificultades' && (!config.capabilities.conversation || !config.enabledChannels.includes('whatsapp')))) {
      throw new CapabilityError('entorno o capacidades del perfil');
    }
    const metrics = new FunctionalMetrics();
    const api = new CentralApi(new HttpTransport(config.central, config, metrics.observe), config.capabilities.conversation);
    const login = (role: Role) => api.login(required('SIM_' + role + '_EMAIL'), required('SIM_' + role + '_PASSWORD'), role);
    const orchestrator = new Orchestrator(new HttpTransport(config.orchestrator, config, metrics.observe),
      config.enabledChannels, config.capabilities.continuity);
    const setup = omnichannel ? [api, orchestrator, { web: credential('web', 'SIM_WEB'),
      whatsapp: credential('whatsapp', 'SIM_WHATSAPP'), callCenter: credential('call-center', 'SIM_CALL_CENTER') }] as const : undefined;
    const fixture = patientFixtures(config.seed, 1).next().value!;
    const threshold = Number(process.env.SIM_FRICTION_DELAY_MS ?? '500');
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 120_000) throw new CapabilityError('SIM_FRICTION_DELAY_MS');
    try {
      return await runProfile(profile, { api, orchestration: setup && [...setup],
        patient: ['nuevo', 'omnicanal', 'administrador'].includes(profile) ? undefined : await login('PATIENT'),
        advisor: profile === 'asesor' || (profile === 'frustrado' && config.enabledChannels.includes('call-center') &&
          process.env.SIM_ADVISOR_EMAIL) ? await login('ADVISOR') : undefined,
        administrator: profile === 'administrador' ? await login('ADMIN') : undefined,
        registration: profile === 'nuevo' ? { ...fixture,
          password: required('SIM_PATIENT_PASSWORD') } : undefined,
        behavior: { ...config.frustration, seed: config.seed, delayMs: threshold,
          mode: config.frustrationMode, allowAssistanceRequest: config.enabledChannels.includes('call-center'),
          canConverse: config.capabilities.conversation && config.enabledChannels.includes('whatsapp'),
          timing: { now: () => performance.now(), wait: ms => delay(ms) } } });
    } finally { console.error(JSON.stringify({ metrics: metrics.summary() })); }
  }
  if (command === 'plan') {
    const random = seededRandom(config.seed);
    return { environment: config.environment, records: config.records, rate: config.rate,
      virtualUsers: config.virtualUsers, durationSeconds: config.durationSeconds,
      thresholds: config.thresholds, capabilities: config.capabilities, scenarios,
      exampleProfiles: Array.from({ length: 5 }, () => chooseProfile(config.weights, random)),
      examplePatient: patientFixtures(config.seed, config.records).next().value };
  }
  if (!Object.hasOwn(scenarios, command)) throw new CapabilityError('escenario desconocido');
  const scenario = command as Scenario;
  const definition = scenarios[scenario];
  if (definition.mode === 'offline') return { fixture: true, trace: frustrationTrace(config) };
  if (definition.mode !== 'functional') throw new CapabilityError(definition.purpose);
  const usesCentral = scenario !== 'idempotency';
  const usesOrchestrator = ['basic', 'continuity', 'idempotency'].includes(scenario);
  if (config.environment !== 'local' || (usesCentral && !isLoopback(config.central)) ||
      (usesOrchestrator && !isLoopback(config.orchestrator))) {
    throw new CapabilityError('ejecución HTTP solo local en esta fase');
  }
  if (definition.writes && !config.allowWrites) throw new CapabilityError('SIM_ALLOW_WRITES');
  if (scenario === 'continuity' && (!config.capabilities.continuity || config.enabledChannels.length !== 3)) {
    throw new CapabilityError('SIM_CONTINUITY y tres canales habilitados');
  }
  if (scenario === 'assisted' && !config.enabledChannels.includes('call-center')) {
    throw new CapabilityError('canal Call Center habilitado');
  }
  if (['schedule', 'assisted', 'continuity', 'version-conflict', 'idempotency'].includes(scenario) &&
      !config.enabledChannels.includes('web')) throw new CapabilityError('canal Web habilitado');
  const metrics = new FunctionalMetrics();
  const central = new CentralApi(new HttpTransport(config.central, config, metrics.observe), config.capabilities.conversation);
  const orchestrator = new Orchestrator(new HttpTransport(config.orchestrator, config, metrics.observe),
    config.enabledChannels, config.capabilities.continuity);
  const login = (role: Role) => central.login(required('SIM_' + role + '_EMAIL'), required('SIM_' + role + '_PASSWORD'), role);
  let result: unknown;
  try {
    switch (scenario) {
      case 'basic': result = await basic(central, orchestrator); break;
      case 'schedule': result = await schedule(central, await login('PATIENT')); break;
      case 'assisted': result = await schedule(central, await login('PATIENT'), await login('ADVISOR')); break;
      case 'continuity': result = await continuity(central, orchestrator, {
        web: credential('web', 'SIM_WEB'), whatsapp: credential('whatsapp', 'SIM_WHATSAPP'),
        callCenter: credential('call-center', 'SIM_CALL_CENTER'),
      }); break;
      case 'admin': result = await admin(central, await login('ADMIN')); break;
      case 'version-conflict': result = await versionConflict(central, await login('PATIENT')); break;
      case 'idempotency': result = await idempotency(orchestrator, credential('web', 'SIM_WEB')); break;
      case 'appointment-status': {
        const page = await central.appointments(await login('PATIENT'), { limit: 10 }, true);
        result = { listed: page.items.length, hasMore: page.hasMore };
        break;
      }
    }
  } finally {
    console.error(JSON.stringify({ metrics: metrics.summary() }));
  }
  return { scenario, result };
}
main().then(result => console.log(JSON.stringify(result, null, 2))).catch((error: unknown) => {
  console.error(error instanceof HttpError || error instanceof ContractError ||
    error instanceof CapabilityError || error instanceof NetworkError ? error.message : 'No se completó la ejecución. Revisa la configuración.');
  process.exitCode = 1;
});
