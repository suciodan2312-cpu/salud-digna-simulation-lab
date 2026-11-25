import { NextRequest } from 'next/server';
import { approvedPlans, job, start, stop } from '../../../lib/runner';
import { artifact, latestCohort, behaviorRuns, datasets, liveRead, monitoredRun, patients, runs, services } from '../../../lib/store';
import { requestAllowed, validateExecution } from '../../../lib/policy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (request.headers.get('host') !== '127.0.0.1:13400') return new Response(null, { status: 403 });
  const file = request.nextUrl.searchParams.get('report');
  if (file) {
    const data = await artifact(file);
    return data ? new Response(new Uint8Array(data), { headers: {
      'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="' + file + '"',
      'x-content-type-options': 'nosniff',
    } }) : new Response(null, { status: 404 });
  }
  try {
    const current = job();
    const [corpora, history, behavior, status, behaviorHistory, live] = await Promise.all([
      datasets(), runs(), patients(), services(), behaviorRuns(),
      current?.state === 'running' && current.plan.scenario === 'patient-reads' ? liveRead(current.id) : monitoredRun(),
    ]);
    return Response.json({ datasets: corpora, runs: history, patients: behavior, services: status,
      latestCohort: await latestCohort(), job: current, behaviorHistory, live, allowed: approvedPlans() }, { headers: { 'cache-control': 'no-store' } });
  } catch { return Response.json({ error: 'No se pudieron leer los artefactos locales.' }, { status: 500 }); }
}

export async function POST(request: NextRequest) {
  if (!requestAllowed(request.headers.get('host'), request.headers.get('sec-fetch-site'), request.headers.get('origin')) ||
      request.headers.get('content-type') !== 'application/json') return Response.json({ error: 'Origen no autorizado.' }, { status: 403 });
  const raw = await request.text();
  if (raw.length > 1200) return Response.json({ error: 'Solicitud demasiado grande.' }, { status: 413 });
  try {
    const body = JSON.parse(raw);
    if (body.action === 'stop' && typeof body.id === 'string') return Response.json(await stop(body.id));
    if (body.action === 'validate') return Response.json({ plan: validateExecution(body.plan) });
    if (body.action !== 'start' || body.confirmed !== true) throw new Error('Confirma la ejecución local.');
    return Response.json(await start(validateExecution(body.plan)), { status: 202 });
  } catch (error) {
    const message = error instanceof Error && /^[A-ZÁÉÍÓÚ][\p{L} .,:0-9áéíóú]+$/u.test(error.message) ? error.message : 'La operación local fue rechazada.';
    return Response.json({ error: message }, { status: 400 });
  }
}
