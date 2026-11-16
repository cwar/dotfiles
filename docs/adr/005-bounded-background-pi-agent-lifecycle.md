# 005. Bounded lifecycle for background Pi agents

Date: 2026-08-12

## Status

Accepted

## Context

Background Pi sessions run as detached runner processes so they survive the
foreground session. The original manager treated an ended turn as indefinitely
replyable `idle` state, exposed active work only inside `/agents`, and stopped
only the runner PID. In practice this caused invisible multi-hour sessions and
orphaned Pi/tool processes after a nominally successful stop.

The foreground Pi can exit while a background session continues, so lifecycle
policy cannot depend on a foreground-only timer. Conversely, a runner cannot
reliably discover every detached descendant after its own child process has
been reparented.

## Decision

Use two cooperating lifecycle owners:

- Each runner persists and enforces a 10-minute settled-idle timeout and a
  2-hour hard runtime limit. Dispatch callers may override either limit; zero
  disables that limit.
- The supervisor performs final cleanup by snapshotting the descendant tree,
  signaling each distinct process group, and verifying both runner and child Pi
  PIDs have exited.
- Foreground Pi sessions display live agent counts persistently in the footer.
  `/agents` shows idle separately from finished work and displays runtime,
  inactivity, and configured limits.
- Background stuck notifications target the dispatching foreground Pi and open
  the manager with the relevant agent selected once that foreground is idle.
- The extension and its lifecycle tests are tracked in the `pi` dotfiles
  package rather than existing only under live `~/.pi` state.

## Consequences

Positive:

- Forgotten agents stop without manual cleanup.
- Stop covers detached descendants instead of only changing recorded state.
- Active and replyable-idle sessions remain visible from the normal Pi footer.
- Limits are explicit and inspectable per job.

Negative / risks:

- A legitimately long task must request a larger hard limit at dispatch.
- Auto-stopped sessions require resuming or redispatching before a follow-up.
- Full descendant cleanup and notification targeting currently depend on Linux
  `/proc` and POSIX process-group behavior.
