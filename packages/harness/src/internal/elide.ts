/**
 * Honest shortening.
 *
 * Every place this harness puts bytes in front of a model is bounded, and every
 * one of those bounds used to be spelled the same way: slice, append `…`, move
 * on. A model reading that cannot tell a value that ends in an ellipsis from a
 * value that was cut, cannot tell how much it lost, and — the expensive part —
 * cannot tell how to get the rest back, so it buys the same bytes again. Three
 * of the five most expensive instances of the r90 wave spent real money
 * re-fetching a region the run had already rendered and silently clipped
 * (`pydata__xarray-7229` $0.76, `sphinx-doc__sphinx-8721` $0.36,
 * `pytest-dev__pytest-6197` $0.19).
 *
 * So a shortened value states three things: that it was shortened, how many
 * bytes are missing, and the id that brings them back. The id is a sentence the
 * caller supplies, because only the caller knows whether the thing is a state
 * key (`render`), a settled call (`recall`), or something the model must fetch
 * again.
 *
 * @since 0.1.0
 * @private
 * @slop
 */

/**
 * Shortens text from the middle, keeping both ends.
 *
 * The two ends are where a file excerpt, a diff, or a test log identifies
 * itself; the middle is where the repetition is. `recall` is the sentence that
 * says how to see what was dropped.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const middle = (text: string, limit: number, recall: string): string => {
  if (text.length <= limit) return text
  const edge = Math.floor(limit / 2)
  return `${text.slice(0, edge)}\n… ${
    text.length - limit
  } of ${text.length} bytes elided from the middle. ${recall} …\n${text.slice(text.length - edge)}`
}

/**
 * Shortens text from the end, keeping the head.
 *
 * Used for the one-line summaries a ledger prints, where the head is the whole
 * of what identifies the line and the tail is detail.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const head = (text: string, limit: number, recall: string): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}… [+${text.length - limit}b, ${recall}]`
