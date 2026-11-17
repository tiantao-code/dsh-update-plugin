/**
 * Browser-face Typert contribution. The client bundle imports this module and
 * mounts it with `ctx.remote.$mount(...)` before using `ctx.remote.dshUpdate`.
 */
import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { TYPERT_SPEC } from './spec.js'

export const TYPERT_REMOTE = createTypertRemoteInfo(TYPERT_SPEC, z)
export default TYPERT_REMOTE
