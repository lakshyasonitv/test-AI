/**
 * Lift the runnable helpers out of a generated spec's TEXT, so a test executes what actually
 * ships rather than a reimplementation that agrees with nothing (`DECISIONS.md` D-19).
 *
 * WHY THIS IS SHARED. Three test files were each carrying their own copy of `extractFn` and their
 * own hand-listed set of helper names. Every time the generator gained a helper, each list went
 * stale independently and the failure was always the same unhelpful `ReferenceError: <thing> is
 * not defined` from inside `new Function`. That has now happened twice — for `scopeOf`, then for
 * `optionProbeJs`. One definition, one list, one place to update.
 *
 * The `ReferenceError` is still the right failure mode: it means the spec changed shape and the
 * test is no longer running what ships. This just makes it happen in one place.
 */

/** One `async function name(...) {...}` or `function name(...) {...}`, by brace matching. */
export function extractFn(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  if (at === -1) throw new Error(`generated spec does not define ${name}()`);
  const start = src.lastIndexOf("async ", at) === at - 6 ? at - 6 : at;
  let depth = 0;
  for (let k = src.indexOf("{", at); k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) return src.slice(start, k + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}()`);
}

/**
 * One `const name = (args) => {...};` — the arrow-function helpers the generator interpolates
 * from `targetResolver.ts` (option matching, the selectable walk). Terminated by the semicolon
 * after the closing brace, not by the next blank line: overshooting drags in unrelated top-level
 * code and the whole `new Function` dies on something irrelevant.
 */
export function extractConst(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = `);
  if (at === -1) throw new Error(`generated spec does not define ${name}`);
  let depth = 0;
  let started = false;
  for (let k = at; k < src.length; k++) {
    if (src[k] === "{") { depth++; started = true; }
    else if (src[k] === "}") {
      depth--;
      if (started && depth === 0) {
        const semi = src.indexOf(";", k);
        if (semi === -1) throw new Error(`unterminated const ${name}`);
        return src.slice(at, semi + 1);
      }
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

/**
 * Every helper `field()`, `choose()` and `safeClick()` transitively need, in dependency order.
 * Kept as one list so a new helper is added once. Names absent from a given spec are skipped —
 * the generator only splices in the helpers a spec actually uses, so a fill-only spec has no
 * `choose()` and asking for one unconditionally would fail for the wrong reason.
 */
const CONSTS = ["optionProbeJs", "matchOptionIndex", "optionErrorMessage", "selectableJs"];
const FNS = ["scopeOf", "firstUnique", "nearField", "field", "choose", "locate", "safeClick"];

/** Build the requested helpers into a callable object, from the spec text itself. */
export function specHelpers(spec: string, want: string[]): Record<string, Function> {
  const parts: string[] = [];
  for (const name of CONSTS) {
    if (spec.includes(`const ${name} = `)) parts.push(extractConst(spec, name));
  }
  for (const name of FNS) {
    if (spec.includes(`function ${name}(`)) parts.push(extractFn(spec, name));
  }
  parts.push(`return { ${want.join(", ")} };`);
  return new Function(parts.join("\n"))() as Record<string, Function>;
}
