import { z } from "zod";

/**
 * SpecModel — the distilled form of ONE requirements document, for Pro mode.
 *
 * Pro mode turns an uploaded document into this structure, shows it to the user to correct and
 * complete, and hands the confirmed result to the Pro case generator (`stages/proTestCases.ts`).
 * It decides WHICH cases get written. It never reaches the IR, grounding, the generator or the
 * executor — those verify against the discovered page, not against what a document claims.
 *
 * TWO SCHEMAS, ONE SHAPE, because the two sources deserve different handling:
 *
 *   - `LlmSpecModel` parses what the MODEL returned. Over-long lists and strings are TRUNCATED,
 *     not rejected: a model that returns 14 questions when told "at most 10" has given a usable
 *     answer with four too many, and failing the whole upload over that would throw away a paid
 *     call. The cap lives here, in the schema, and not only in the prompt — an LLM instruction is
 *     a preference, not a constraint (CLAUDE.md's central design rule).
 *
 *   - `SpecModel` parses what the BROWSER sent back (`POST /api/spec/confirm`, `options.spec` on
 *     `POST /api/runs`). That is client input, so it is REJECTED when over a bound rather than
 *     silently cut: truncating would quietly drop rules the user typed, and nothing would tell
 *     them.
 *
 * Every list and string is bounded either way. The confirmed spec is folded into a generation
 * prompt, so an unbounded field here is an unbounded prompt there (TD-73).
 */

/** The questions column holds at most this many. Enforced by both schemas. */
export const MAX_UNRESOLVED = 10;
/** Upper bound on every other list — generous for a real document, a ceiling for a runaway one. */
export const MAX_LIST_ITEMS = 50;
/** Upper bound on one rule / criterion / question. A rule is a sentence, not a page. */
export const MAX_ITEM_CHARS = 500;
/** Upper bound on one free-text answer the user types. */
export const MAX_ANSWER_CHARS = 1000;

const Item = z.string().trim().min(1).max(MAX_ITEM_CHARS);
const List = (max: number) => z.array(Item).max(max);

export const SpecAnswer = z.object({
  question: Item,
  answer: z.string().trim().min(1).max(MAX_ANSWER_CHARS),
}).strict();
export type SpecAnswer = z.infer<typeof SpecAnswer>;

/** The confirmed spec, as accepted from the browser. Strict: unknown keys are rejected. */
export const SpecModel = z.object({
  actors: List(MAX_LIST_ITEMS).default([]),
  entities: List(MAX_LIST_ITEMS).default([]),
  actions: List(MAX_LIST_ITEMS).default([]),
  /** Testable constraints. The column the user edits on the questions screen. */
  rules: List(MAX_LIST_ITEMS).default([]),
  /** Acceptance criteria. */
  criteria: List(MAX_LIST_ITEMS).default([]),
  /** Things the document excludes — suppresses cases for them. */
  outOfScope: List(MAX_LIST_ITEMS).default([]),
  /** Questions the document left open. */
  unresolved: List(MAX_UNRESOLVED).default([]),
  /**
   * The user's answers. Only questions the user actually answered appear here: an unanswered
   * question is ABSENT, never defaulted, never "N/A" — the generator must not be handed a guess
   * dressed as an answer.
   */
  answers: z.array(SpecAnswer).max(MAX_UNRESOLVED).default([]),
}).strict();
export type SpecModel = z.infer<typeof SpecModel>;

/** Normalise one model-returned list: keep strings, trim, drop blanks, cut long ones, cap count. */
const truncatedList = (max: number) => z.preprocess(
  (v) => Array.isArray(v)
    ? v.filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => s.slice(0, MAX_ITEM_CHARS))
      .slice(0, max)
    : [],
  List(max),
);

/**
 * What the distillation model returned, made safe. Never rejects for being too long; a
 * non-array field becomes empty rather than failing the parse. `answers` is never accepted from
 * the model — answers come from the user, so a model-supplied one is dropped.
 */
export const LlmSpecModel = z.object({
  actors: truncatedList(MAX_LIST_ITEMS),
  entities: truncatedList(MAX_LIST_ITEMS),
  actions: truncatedList(MAX_LIST_ITEMS),
  rules: truncatedList(MAX_LIST_ITEMS),
  criteria: truncatedList(MAX_LIST_ITEMS),
  outOfScope: truncatedList(MAX_LIST_ITEMS),
  unresolved: truncatedList(MAX_UNRESOLVED),
}).transform((s): SpecModel => ({ ...s, answers: [] }));

/** True when distillation found nothing at all — for a PDF, usually a scanned image. */
export function isEmptySpec(s: SpecModel): boolean {
  return s.actors.length + s.entities.length + s.actions.length + s.rules.length
    + s.criteria.length + s.outOfScope.length + s.unresolved.length === 0;
}
