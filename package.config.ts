import {defineConfig} from '@sanity/pkg-utils'

export default defineConfig({
  /**
   * The default runtime in pkg-utils is `*`, which assumes the top level `source` entries are meant to run in both Node.js and browsers.
   * However the default exports are using `src/node.ts` and browsers will load the `src/browser.ts` version, so we can safely set the runtime to `node`.
   * The `browser.source` condition automatically changes the runtime to `browser` for the `src/browser.ts` entry.
   */
  runtime: 'node',
})
