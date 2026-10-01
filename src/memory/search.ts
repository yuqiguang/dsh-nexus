/** Full-text ranking for memory events without a native module: ASCII words plus CJK bigrams, weighted by rarity and recency. */

const CJK = /[㐀-鿿豈-﫿]/u;

/** Lower-cased ASCII words and every CJK bigram (single CJK characters count when a run is one character long). */
export function tokens(text: string): string[] {
  const out: string[] = [];
  let run = '';
  const flushRun = () => {
    if (run.length === 1) out.push(run);
    for (let index = 0; index + 1 < run.length; index++) out.push(run.slice(index, index + 2));
    run = '';
  };
  let word = '';
  const flushWord = () => { if (word) out.push(word.toLowerCase()); word = ''; };
  for (const char of text) {
    if (CJK.test(char)) { flushWord(); run += char; continue; }
    flushRun();
    if (/[\p{L}\p{N}]/u.test(char)) word += char; else flushWord();
  }
  flushRun(); flushWord();
  return out;
}

export interface Searchable { id: string; text: string; tags?: string[]; at: number }

export interface Ranked<T> { item: T; score: number }

/**
 * Query-term overlap weighted by inverse document frequency (a term that every
 * event contains says nothing), with a small recency tie-breaker. Items that
 * share no term with the query are not returned at all: relevance gating, not
 * top-k of everything.
 */
export function rank<T extends Searchable>(query: string, items: readonly T[], now = Date.now()): Ranked<T>[] {
  const terms = [...new Set(tokens(query))];
  if (terms.length === 0 || items.length === 0) return [];
  const docs = items.map(item => new Set(tokens(`${item.text} ${(item.tags ?? []).join(' ')}`)));
  const idf = new Map(terms.map(term => {
    const hits = docs.filter(doc => doc.has(term)).length;
    return [term, Math.log(1 + (items.length - hits + 0.5) / (hits + 0.5))];
  }));
  const ranked: Ranked<T>[] = [];
  items.forEach((item, index) => {
    const doc = docs[index]!;
    let score = 0;
    for (const term of terms) if (doc.has(term)) score += idf.get(term)!;
    if (score <= 0) return;
    const ageDays = Math.max(0, now - item.at) / 86_400_000;
    ranked.push({ item, score: score + 0.05 / (1 + ageDays / 30) });
  });
  return ranked.sort((a, b) => b.score - a.score || b.item.at - a.item.at);
}
