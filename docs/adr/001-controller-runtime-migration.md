# ADR-001: Controller Runtime Migration

**Status:** Superseded by ADR-002.  The shell controller this ADR
migrated from was fully retired by the in-process plugin engine
(`cli/hivemoot_agent/engine.py`) and its workqueue/coalescing layer.
Retained as a historical record of the shell-era architecture.
**Date:** 2026-02-20
**Issue:** [#89](https://github.com/hivemoot/hivemoot-agent/issues/89)

## Context

The host-side controller orchestrates isolated Docker worker containers per job. As
of 2026-03, when this ADR was accepted, `scripts/controller.sh` was a Bash 4+ monolith
of 2,342 lines implementing:

- Filesystem-backed job queue (trigger → processing → done/failed)
- Per-repo mutual exclusion via `flock`
- Mention watching via supervised subprocess + dedup on `ack_key`
- Orphan recovery for stale `.processing` files
- Signal handling for graceful shutdown

PR [#513](https://github.com/hivemoot/hivemoot-agent/pull/513) (merged 2026-04) split
the monolith into the `controller/` module structure (`controller/main.sh`,
`controller/core/`, `controller/triggers/`), growing to approximately 3,650 lines total
across the module. This decomposition is positive: it makes the code easier to
understand and reduces merge conflicts — it does not change the migration analysis
below. The shell implementation is still appropriate for current scale, and the same
migration triggers apply.

### Why shell works now

- Control loop is single-threaded; no concurrent state mutations
- State is fully representable as filesystem objects (queue files, lock files, status files)
- Failure modes are observable via Docker and filesystem inspection
- Restart recovery is handled by `recover_orphaned_triggers()` within the orphan
  recovery window
- No external dependencies beyond `docker`, `flock`, `jq`, and Bash 4+
- All agents in the colony can read and modify controller code without a build step

## Decision

**Stay in shell until at least one migration trigger fires.**

In-container scripts (`worker/run-once.sh`, `worker/drivers/`, `shared/lib.sh`) are the
agent runtime, not the controller. They stay in shell permanently unless a separate
trigger fires for that layer. This ADR covers the host-side controller only.

## Migration Triggers

Triggers are ordered by expected probability of firing first.

### T1 - Restart state recovery fails in production *(most likely first trigger)*

Two or more incidents where a controller restart leaves worker containers in an unknown
state that `recover_orphaned_triggers()` cannot recover from: the container ran to
completion but no `.done` marker exists, or a `.processing` file is missing because the
controller died before writing it.

Recovery today depends on matching filesystem artifacts to live PIDs. That seam breaks
if the controller process dies between `docker run` returning a container ID and writing
the `.processing` file. A durable job store (or Docker label-based recovery via
`docker ps --filter label=hivemoot.controller=true`) is the fix, and that is simpler
to implement correctly in a language with native data structures.

**Measurement:** Controller restart incident log; any `.done`-less container after
unplanned restart counts.

### T2 - Queue scan latency exceeds threshold

`queue_has_ack_key()` scans all `.trigger`, `.processing`, and `.done` files on every
mention enqueue. With `QUEUE_ARTIFACT_TTL_SECS=604800` (7-day default), a deployment
with high mention volume accumulates `.done` files unboundedly. On tmpfs, `grep -Fq`
over 500 files takes ~50ms; over 5,000 files ~500ms.

**Trigger threshold:** Queue artifact count exceeds 1,000 entries *and* `queue_has_ack_key`
latency exceeds 200ms in steady state.

**Near-term mitigation (does not require migration):** Lower `QUEUE_ARTIFACT_TTL_SECS`,
or call `prune_queue_artifacts` more aggressively when depth exceeds 500 entries. This
extends the viable shell operating range significantly.

**Measurement:** Add timing log around `process_queue` calls and artifact count to
controller periodic loop output.

### T3 - Concurrent control-plane I/O required

If we need a health endpoint (for load balancers), a metrics scrape endpoint (for
Prometheus), and job dispatch concurrently while the main loop runs, shell's `read`
blocking model breaks. Multiple persistent connections require goroutine-per-concern.

Current state: no external endpoints. This trigger is not near.

### T4 - Kubernetes deployment

If we target K8s, `docker run` must be replaced with K8s Job API calls. That API is
HTTP, not a subprocess. Doing it in shell via `curl + jq` is technically possible but
operationally fragile at scale. Go's `k8s.io/client-go` makes this straightforward.

Current state: Docker Compose only. This trigger is not near.

## Language Comparison

If migration is triggered, the target language is **Go**.

| | Go | Python | Rust |
|---|---|---|---|
| Single binary | `go build` static binary | requires interpreter + venv | yes, but higher compile cost |
| Docker API | `github.com/docker/docker/client` | `docker-py` | `bollard` crate |
| Startup latency | <10ms | 100ms–300ms (interpreter init) | <5ms |
| Memory per instance | ~5–15 MB | 50–100 MB+ | ~2–5 MB |
| Maintainability | High for infra/ops teams | High for general | Moderate (ownership/lifetimes) |
| Agent-maintainable | yes, with Go toolchain | yes, with Python | steep learning curve |
| Ecosystem fit | CNCF-standard (Docker, K8s, GH CLI) | Strong scripting/ML | Over-engineered for I/O-bound work |

### Why Go specifically

`github.com/docker/docker/client` maps directly to what `spawn_worker()` does via
subprocess today:

- `ContainerCreate` + `ContainerStart` → replaces `docker run -d`
- `ContainerWait` → returns a channel, not a blocking call; the controller can wait
  on multiple containers concurrently and survive a restart by re-attaching to a
  container ID via `docker ps --filter label=hivemoot.controller=true`
- `ContainerLogs` → streaming log attach, replacing `docker logs -f`
- `ContainerRemove` → replaces `docker rm`

The subprocess boundary is where restart-state recovery can fail: the PID tracking in
`pid_to_processing_file[]` depends on the controller process staying alive. A Go
controller using `ContainerWait` over a channel eliminates that failure class by
tracking container IDs (Docker-durable) instead of PIDs (process-ephemeral).

**External validation:**
Buildkite rewrote their Ruby agent in Go for exactly the same reasons that would drive
our migration: single binary deployment (no interpreter), reduced memory footprint
(70 MB–3.5 GB Ruby → 1.5–3.3 MB Go), and a concurrency model that scales with job
count. Their trigger was installation friction and memory growth, not feature requests.
Memory figures from the v3.0 release post
([buildkite/agent CHANGELOG](https://github.com/buildkite/agent/blob/main/CHANGELOG.md),
agent v3.0.0, 2017-09-07).

**Python** is acceptable if the team has a strong preference, but we would still shell
out for Docker operations via `subprocess.run("docker run ...")`, which means the main
benefit of migration (durable container tracking without subprocess PIDs) would be
partially lost. Not recommended.

**Rust** is over-engineered for a controller that is primarily I/O-bound and not
performance-critical.

## Preconditions for Migration

Before migration starts (when any trigger fires):

1. **Go controller binary has a defined build and validation path.** The Go
   controller binary is built at image-build time via a multi-stage Dockerfile
   stage, or cross-compiled on the host. Agents validate changes by running the
   pre-built binary and its tests via CI, not by running `go build` inside the
   runtime container (`node:24-slim` ships no Go toolchain and that image stays
   as-is). Confirm CI includes a controller build and test step before migration
   work starts.

2. **Migration does not break agent-led maintenance.** If agents cannot propose and
   test controller changes post-migration, the maintenance throughput cost outweighs
   the reliability gain. This is an explicit gate.

## Migration Plan (when triggered)

### Phase M1 - Canary (1 agent slot)

Port `spawn_worker()` and the job lifecycle to Go. Run the Go controller binary for
1 agent slot; shell controller for remaining slots. Gate on same job success rate
±2% over 48 hours. Rollback: `CONTROLLER_BINARY=shell` restores shell path.

### Phase M2 - Expand (3 agent slots)

Migrate 3 agent slots to Go controller. Gate on no restart-state failures over 7 days
and queue latency within 2× baseline.

### Phase M3 - Complete

Migrate all slots. Retire shell controller from runbooks. Keep `controller.sh` in repo
for 90 days as emergency rollback reference, then archive.

## What We Are NOT Migrating

- **In-container scripts** (`worker/run-once.sh`, `worker/drivers/`, `shared/lib.sh`):
  these are the agent runtime, not the controller. They stay in shell unless a
  separate trigger fires.
- **The Docker image**: `node:24-slim` base stays. The Go controller binary runs on the
  host or in a sidecar container alongside the existing image.

## Discussion

Thread consensus on trigger set, language recommendation, and migration phases reached
in issue [#89](https://github.com/hivemoot/hivemoot-agent/issues/89).

See also: [VISION.md](../../VISION.md) — Operational Simplicity principle constrains
the migration to be triggered by a concrete operational failure, not a hypothetical one.
