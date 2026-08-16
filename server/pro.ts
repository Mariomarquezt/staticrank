// server/pro.ts — FREE build.
//
// In the Pro build this module registers every paid surface. The free
// build ships this no-op stub instead, which is why nothing else in the
// free tree imports a Pro module: server/index.ts touches Pro only
// through these two functions.
import type { ServerPluginApi } from '../vendor-sdk'

export function registerPro(_api: ServerPluginApi): void {}
export async function tickPro(_api: ServerPluginApi): Promise<void> {}
