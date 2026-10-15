/**
 * Public surface of the Deep Research helpers package (Wave 1, items D.2.5 / D.2.6 / D.2.7).
 *
 * Wave 2 (D.2.1 — the research runner) will compose these. Other modules
 * should import from this barrel rather than reaching into the leaf files.
 */

export type {
  ExtractedFinding,
  ResearchCategory,
  StopVerdict,
} from './types.js';
export { RESEARCH_CATEGORIES } from './types.js';

export { extractFromSource } from './extractor.js';
export type { ExtractInput } from './extractor.js';

export { shouldStopResearch } from './stopCriterion.js';
export type { StopInput } from './stopCriterion.js';

export { classifyQuery, CATEGORY_TEMPLATES } from './categories.js';

export { parseLlmJson, LlmJsonParseError } from './jsonParse.js';

// Wave 2 runner (D.2.1) + its wiring surface (CLI `uplnk research`,
// ChatScreen `@research <topic>` trigger).
export { runResearch } from './runner.js';
export type {
  ResearchEvent,
  ResearchResult,
  ResearchRunOptions,
} from './runnerTypes.js';
export { parseResearchTrigger, describeResearchEvent } from './trigger.js';

export {
  EXTRACTOR_SYSTEM,
  EXTRACTOR_USER_TEMPLATE,
  STOP_SYSTEM,
  STOP_USER_TEMPLATE,
  CATEGORY_SYSTEM,
  CATEGORY_USER_TEMPLATE,
} from './prompts.js';
