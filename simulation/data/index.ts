import { seededRandom } from '../engine/index.js';

// Streaming preview fixtures. No database access or persistence.
export function* patientFixtures(seed: number, count: number) {
  if (!Number.isSafeInteger(count) || count < 0 || count > 5_000_000) throw new Error('Volumen inválido');
  const random = seededRandom(seed);
  const firstNames = ['Alex', 'Carmen', 'Elena', 'Gabriel', 'Lucía', 'Rafael'] as const;
  for (let index = 0; index < count; index++) {
    const sequence = index + 1;
    yield { firstName: firstNames[Math.floor(random() * firstNames.length)]!,
      lastName: 'Fixture ' + sequence, email: `paciente-${seed}-${sequence}@example.test` };
  }
}
