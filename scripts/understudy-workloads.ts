/**
 * Registers every workload in `lib/ai/workload.ts` with the Understudy gateway (issue #76),
 * capture on and no route. Safe to run again: a workload already there is left alone.
 *
 *   pnpm understudy:workloads                     # the project in UNDERSTUDY_PROJECT, or rehearsal
 *   pnpm understudy:workloads --project storytime
 *   pnpm understudy:workloads --dry-run           # print what would be created
 *
 * Needs the `understudy` CLI signed in. It changes gateway configuration only - no model call.
 */
import { execFileSync } from 'node:child_process'
import { DEFAULT_UNDERSTUDY_PROJECT, WORKLOADS } from '@/lib/ai/workload'

/** `--name=value` or `--name value`. */
export function arg(name: string, argv: readonly string[] = process.argv): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (i < 0) return undefined
  return argv[i]!.includes('=') ? argv[i]!.slice(name.length + 3) : argv[i + 1]
}

export function missingWorkloads(existing: readonly string[]): string[] {
  return WORKLOADS.filter((w) => !existing.includes(w))
}

function main(): void {
  const project = arg('project') ?? (process.env.UNDERSTUDY_PROJECT || DEFAULT_UNDERSTUDY_PROJECT)
  const dryRun = process.argv.includes('--dry-run')
  const listed = JSON.parse(
    execFileSync('understudy', ['workloads', 'list', '--project', project, '--json'], { encoding: 'utf8' }),
  ) as { workloads: { name: string }[] }
  const missing = missingWorkloads(listed.workloads.map((w) => w.name))
  console.log(`project ${project}: ${WORKLOADS.length - missing.length} of ${WORKLOADS.length} workloads already registered`)
  for (const name of missing) {
    if (dryRun) {
      console.log(`  would create ${name}`)
      continue
    }
    execFileSync('understudy', ['workloads', 'create', name, '--project', project, '--capture', '--json'], { stdio: 'ignore' })
    console.log(`  created ${name}`)
  }
}

if (process.argv[1]?.endsWith('understudy-workloads.ts')) main()
