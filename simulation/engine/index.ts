import { friction, type Friction, type Profile } from '../profiles/index.js';
import type { Config } from '../config/index.js';

export function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
export function chooseProfile(weights: Config['weights'], random: () => number): Profile {
  const entries = Object.entries(weights) as [Profile, number][];
  let pick = random() * entries.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [profile, weight] of entries) {
    if (pick < weight) return profile;
    pick -= weight;
  }
  throw new Error('Distribución sin perfiles activos');
}

export type Decision = 'continue' | 'retry' | 'switch' | 'assist' | 'abandon' | 'resume' | 'wait';
export class FrustratedPatient {
  private score: number;
  private retries = 0;
  private abandoned = false;
  constructor(private readonly options: Config['frustration'], private readonly random: () => number) {
    this.score = options.initial;
  }
  get frustration() { return this.score; }

  observe(event: Friction) {
    this.score = Math.max(0, Math.min(100, this.score + friction[event]));
    return this.score;
  }

  decide(event: Friction, available: { safeRetry: boolean; canSwitch: boolean; canAssist: boolean }): Decision {
    this.observe(event);
    if (this.abandoned) {
      if (event !== 'humanResolved' && this.random() >= 0.25) return 'wait';
      this.abandoned = false;
      return 'resume';
    }
    if (event === 'humanResolved' || event === 'contextRecovered') return 'continue';
    if (event === 'startingConcern' && this.score >= 60 && available.canAssist) return 'assist';
    if (this.score >= 90) {
      this.abandoned = true;
      return 'abandon';
    }
    if (this.score >= 60 && available.canAssist) return 'assist';
    if (this.score >= 40 && available.canSwitch) return 'switch';
    if (available.safeRetry && this.retries < this.options.retryBudget) {
      this.retries++;
      return 'retry';
    }
    return 'wait';
  }
}
