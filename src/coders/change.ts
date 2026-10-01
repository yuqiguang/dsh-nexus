import type { CoderBrief } from './brief.js';
import { validatePlan, type PlanStep } from './plan.js';

export interface BriefChange { objective: string; constraints: string; acceptance: string[]; steps?: PlanStep[]; affected: string[] }
export function analyzeChange(brief: CoderBrief, input: { objective?: string; constraints?: string; acceptance?: string[]; steps?: unknown }): BriefChange {
  const objective = input.objective ?? brief.objective, constraints = input.constraints ?? brief.constraints;
  const acceptance = input.acceptance ?? brief.acceptance.map(item => item.text);
  const criteria = acceptance.map((text, index) => ({ id: `a${index + 1}`, text }));
  const steps = input.steps !== undefined ? validatePlan(input.steps, criteria) : undefined;
  const fundamental = objective !== brief.objective || constraints !== brief.constraints || JSON.stringify(acceptance) !== JSON.stringify(brief.acceptance.map(item => item.text));
  const next = steps ?? (fundamental ? undefined : brief.plan);
  const affected = new Set<string>();
  const combined = [...(brief.plan ?? []), ...(next ?? [])];
  for (const step of combined) if (fundamental || JSON.stringify(brief.plan?.find(item => item.id === step.id)) !== JSON.stringify(next?.find(item => item.id === step.id))) affected.add(step.id);
  let changed = true;
  while (changed) { changed = false; for (const step of combined) if (!affected.has(step.id) && step.depends_on.some(id => affected.has(id))) { affected.add(step.id); changed = true; } }
  return { objective, constraints, acceptance, steps: next, affected: fundamental && !combined.length ? ['全部任务'] : [...affected] };
}
