import { server } from "./v1.js"
import { v2 } from "./v2.js"

export type { UnityGameDevPluginOptions } from "./shared.js"

/**
 * OpenCode V2 reads `id` and `setup`; OpenCode 1.18.29+ calls `server`.
 * Each side uses its own API; nothing is translated between them.
 */
export default {
  ...v2,
  server,
}
