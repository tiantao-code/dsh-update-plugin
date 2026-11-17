/**
 * Hand-written Typert facts for the `dshUpdate` Host service.
 *
 * `@deepseek-ai/dsh-typert-generator` is not part of the published DSH install,
 * so this file plays the role of its output. Keep `PACKAGE_NAME` in sync with
 * package.json: `dsh-typert-loader` rejects a manifest whose `package` differs
 * from the owning package name.
 */
import { z } from 'zod'

export const PACKAGE_NAME = '@your-scope/dsh-update'
export const SERVICE_NAME = 'dshUpdate'

const sourceLocation = (line: number) => ({
  file: 'src/index.ts',
  line,
  column: 3,
})

const jsonCodec = (typeSymbol: string, create: () => z.ZodType, description: string) => ({
  mode: 'strict' as const,
  typeSymbol,
  create,
  description,
  jsonSchema: {},
})

const requestParameter = (
  name: string,
  typeSymbol: string,
  create: () => z.ZodType,
  description: string,
  acceptsUndefined = false,
) => ({
  name,
  description,
  source: 'json' as const,
  ...(acceptsUndefined ? { acceptsUndefined: true } : {}),
  codec: jsonCodec(typeSymbol, create, description),
  strictCodec: jsonCodec(typeSymbol, create, description),
})

const result = (name: string, description: string) => ({
  mode: 'strict' as const,
  typeSymbol: `${PACKAGE_NAME}#${SERVICE_NAME}/${name}:result`,
  // The gateway and the browser both call `create().parse(value)`. The Host is
  // the validation boundary; results are shaped objects, so `z.any()` keeps the
  // hand-written artifact resilient to additive fields.
  create: () => z.any(),
  description,
  jsonSchema: {},
})

const method = (
  name: string,
  description: string,
  parameters: ReturnType<typeof requestParameter>[],
  resultDescription: string,
  line: number,
) => ({
  service: SERVICE_NAME,
  description,
  invocation: { kind: 'direct' as const },
  parameters,
  result: result(name, resultDescription),
  sourceLocation: sourceLocation(line),
})

const optionalObject = <T extends z.ZodRawShape>(shape: T) =>
  z.union([z.undefined(), z.looseObject(shape)])

export const TYPERT_SPEC = {
  package: PACKAGE_NAME,
  methods: {
    'dshUpdate/check': method(
      'check',
      'Check the registry for newer rc/alpha versions of @deepseek-ai/dsh.',
      [
        requestParameter(
          'request',
          `${PACKAGE_NAME}#CheckRequest`,
          () => optionalObject({ force: z.boolean().optional() }),
          'Optional cache bypass.',
          true,
        ),
      ],
      'Registry snapshot and per-version candidates.',
      157,
    ),
    'dshUpdate/plan': method(
      'plan',
      'Build a compatibility and session plan for one target version.',
      [
        requestParameter(
          'target',
          `${PACKAGE_NAME}#TargetVersion`,
          () => z.string(),
          'Exact semver version to install.',
        ),
      ],
      'Update plan for the confirmation step.',
      202,
    ),
    'dshUpdate/pause': method(
      'pause',
      'Stop the selected sessions and wait until their activity drains.',
      [
        requestParameter(
          'request',
          `${PACKAGE_NAME}#PauseRequest`,
          () => z.looseObject({ sessionIds: z.array(z.string()) }),
          'Sessions selected by the user.',
        ),
      ],
      'Per-session pause outcome.',
      220,
    ),
    'dshUpdate/start': method(
      'start',
      'Start the staged install, pause, and atomic switch workflow.',
      [
        requestParameter(
          'request',
          `${PACKAGE_NAME}#StartRequest`,
          () =>
            z.looseObject({
              target: z.string(),
              pauseSessionIds: z.array(z.string()).optional(),
              acceptRisk: z.boolean(),
            }),
          'Target version and accepted risk.',
        ),
      ],
      'Immediately available update id.',
      252,
    ),
    'dshUpdate/status': method(
      'status',
      'Read the current update status and progress.',
      [],
      'Current status snapshot.',
      365,
    ),
    'dshUpdate/cancel': method(
      'cancel',
      'Cancel a cancellable update and remove its staging directory.',
      [
        requestParameter(
          'id',
          `${PACKAGE_NAME}#UpdateId`,
          () => z.string(),
          'Update id returned by start.',
        ),
      ],
      'Status after cancellation.',
      371,
    ),
    'dshUpdate/logs': method(
      'logs',
      'Read a byte range of the update log.',
      [
        requestParameter(
          'request',
          `${PACKAGE_NAME}#LogsRequest`,
          () => z.looseObject({ id: z.string(), offset: z.number().optional() }),
          'Log id and byte offset.',
        ),
      ],
      'Log chunk and next offset.',
      397,
    ),
  },
}

export type TypertSpec = typeof TYPERT_SPEC
