/**
 * Runner id -> output grammar.
 *
 * The ids are the ones `runners.js` publishes (`src/core/runners.js`), plus the
 * old `kind` spellings and a `generic` fallback so an unknown or unsupported
 * runner degrades to "colour the line, count nothing" instead of pretending.
 * @module dsh-test-live/grammars
 */

import { generic } from './generic.js'
import { go } from './go.js'
import { jest } from './jest.js'
import { nodeTest } from './node-test.js'
import { pytest } from './pytest.js'
import { script } from './script.js'
import { vitest } from './vitest.js'

export const GRAMMARS = Object.freeze({ go, vitest, jest, nodeTest, pytest, script, generic })

/** Spellings that must land on a grammar instead of the generic fallback. */
const ALIASES = Object.freeze({
  'node-test': 'nodeTest',
  nodetest: 'nodeTest',
  node: 'nodeTest',
  'go-test': 'go',
  golang: 'go',
  unknown: 'generic',
  command: 'generic',
})

/**
 * @param runnerId - runner id, or undefined for the legacy Go behaviour.
 * @returns the grammar to use; never null.
 */
export function getGrammar(runnerId) {
  if (typeof runnerId !== 'string' || runnerId.trim() === '') return go
  const id = runnerId.trim()
  const key = ALIASES[id.toLowerCase()] ?? id
  return GRAMMARS[key] ?? GRAMMARS.generic
}

/**
 * Labels the panel uses for a runner's suite bucket (包 / 文件 / 用例).
 * @param runnerId - runner id.
 * @returns { suite } with one label.
 */
export function grammarLabels(runnerId) {
  return { ...getGrammar(runnerId).labels }
}
