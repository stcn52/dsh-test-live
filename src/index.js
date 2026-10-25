/**
 * dsh-test-live — live test logs in the DeepSeek Harness sidebar.
 *
 * One run registry feeds three surfaces: the sidebar panel (SSE), the HTTP
 * routes the panel talks to, and three tools the model can call. The plugin
 * imports nothing from `@deepseek-ai/*`: it consumes the `tools` and
 * `webServer` services and Node built-ins only, so it loads from a profile
 * without peer resolution.
 * @module dsh-test-live
 */

import { resolveConfig } from './core/config.js'
import { createHub } from './core/runner.js'
import { registerRoutes } from './host/routes.js'
import { registerTools } from './tools/index.js'

/** Cordis plugin name; also the settings namespace of the plugin row. */
export const name = 'test-live'

/** Without the tool registry there is nothing to mount. */
export const inject = ['tools']

/**
 * Build the run registry and mount both halves.
 * @param ctx - Cordis context (provides `tools`).
 * @param config - the plugin row's config; validated here so a deployment typo
 * fails at load instead of on the first run.
 */
export function apply(ctx, config) {
  // A bad config must not take the host down: fall back to the defaults and
  // record the problem where a human will see it.
  let settings
  try {
    settings = resolveConfig(config)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(`dsh-test-live: ${message}; using defaults`)
    settings = resolveConfig({})
  }
  const hub = createHub(settings)
  // Kill any lingering child when the plugin is unloaded; a running test process
  // outliving its panel would be a leaked process with no way to stop it.
  ctx.effect(() => () => hub.dispose())
  registerTools(ctx, hub)
  // Profiles without a web server (headless, SDK) simply keep the tools.
  registerRoutes(ctx, hub)
}
