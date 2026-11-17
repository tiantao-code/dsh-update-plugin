/**
 * Host-face Typert manifest. Loaded by `@deepseek-ai/dsh-typert-loader` through
 * the package's `./typert` export; it is intentionally hand-written because the
 * generator is not shipped in the published DSH install.
 */
import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { PACKAGE_NAME, TYPERT_SPEC } from './spec.js'

const $remote = createTypertRemoteInfo(TYPERT_SPEC, z)

export const TYPERT = {
  package: PACKAGE_NAME,
  face: 'host' as const,
  schemas: [],
  get invocations() {
    return $remote.descriptors
  },
  model: {
    services: [],
    events: [],
    objects: [],
  },
}
