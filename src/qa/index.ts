/**
 * The investigation loop, as the rest of the product sees it.
 *
 * One function and the vocabulary of its answer. Everything else — the tools,
 * the prompt, the citation ledger — is how it works rather than what it is, and
 * a caller that reaches past this is a caller that will break when any of it
 * changes.
 *
 * `readers.ts` is deliberately NOT re-exported here. It imports the database
 * and GitHub, and this file is what a test imports.
 */
export { investigate, type InvestigateInput } from "./loop";
export type { InvestigationFocus } from "./prompt";
export type { SourceReader, SourceResult, SourceRefusal } from "./source";
export type {
  Budget,
  Citation,
  Finding,
  Investigation,
  QaEvent,
  QaEventPayloads,
  QaEventSink,
  QaEventType,
  QaToolName,
  QaTrail,
  RefusalReason,
  RefusedFinding,
  Spend,
  StopReason,
  TrailHop,
  TrailHopVia,
  TrailPoint,
} from "./types";
export { DEFAULT_BUDGET } from "./types";
