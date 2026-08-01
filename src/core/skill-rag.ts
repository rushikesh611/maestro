import type { Skill } from './types';

/**
 * Tokenizes text into lowercase words, stripping punctuation.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

/**
 * Computes a relevance score between a query and a skill.
 *
 * Scoring weights (higher = more important):
 *   - Tag exact match:          4 pts per hit
 *   - Skill name token match:   3 pts per hit
 *   - Description token match:  2 pts per hit
 *   - Content token match:      1 pt  per hit (capped at 10)
 */
function scoreSkill(queryTokens: string[], skill: Skill): number {
  let score = 0;

  const tagTokens = skill.tags.flatMap(t => tokenize(t));
  const nameTokens = tokenize(skill.name);
  const descTokens = tokenize(skill.description);
  const contentTokens = tokenize(skill.content);

  for (const qt of queryTokens) {
    if (tagTokens.includes(qt)) score += 4;
    if (nameTokens.includes(qt)) score += 3;
    if (descTokens.includes(qt)) score += 2;
  }

  // Content match capped — avoids large skill bodies dominating small tasks
  let contentHits = 0;
  for (const qt of queryTokens) {
    if (contentTokens.includes(qt)) {
      contentHits++;
      if (contentHits >= 10) break;
    }
  }
  score += contentHits;

  return score;
}

/**
 * Selects the top-K most relevant skills for the given task query.
 * Injects all skills when K <= 0 or there are fewer skills than K.
 * Skills with zero relevance score are excluded unless no skills score > 0.
 */
export function selectRelevantSkills(query: string, skills: Skill[], topK = 3): Skill[] {
  if (!skills.length) return [];

  const queryTokens = tokenize(query);

  if (!queryTokens.length) {
    // No query tokens — fall back to first topK skills
    return skills.slice(0, topK);
  }

  const scored = skills
    .map(skill => ({ skill, score: scoreSkill(queryTokens, skill) }))
    .sort((a, b) => b.score - a.score);

  const nonZero = scored.filter(s => s.score > 0);

  // If nothing scored, return the first topK (better than injecting nothing)
  const candidates = nonZero.length > 0 ? nonZero : scored;

  return candidates.slice(0, topK).map(s => s.skill);
}
