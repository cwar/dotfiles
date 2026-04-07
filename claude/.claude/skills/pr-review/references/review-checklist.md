# Review Checklists by Domain

Domain-specific things to look for when reviewing changes in each phase. These supplement the general review focus areas in the main skill — use the relevant section(s) based on what files are in the current phase.

## Cross-Cutting: Check Beyond the Diff

For every phase, especially IaC, proactively check files **not in the PR** that reference changed resources. This is where critical bugs hide.

- When a module gets `count` added: `grep -rn "module\.name" *.tf` — every direct reference (`module.x.output`) will break because it becomes `module.x[0].output`
- When a resource is renamed or moved: check `depends_on`, provider configs, outputs, and other modules that consume it
- When a variable changes type or semantics: check all call sites across workspaces/environments
- When outputs change: check what consumes them (other modules, provider blocks, external references)

## Terraform / OpenTofu

Terraform changes are high-blast-radius — a bad merge can take down infrastructure. Review carefully.

### Resource Changes
- **Naming conventions**: Do resources follow the project's naming pattern? Check for consistency with existing resources.
- **State implications**: Will this rename or recreate a resource? Look for `name` or `name_prefix` changes on existing resources — these often force replacement.
- **Lifecycle rules**: Should `prevent_destroy`, `create_before_destroy`, or `ignore_changes` be set?
- **Dependencies**: Are `depends_on` blocks correct? Are there implicit dependencies that should be explicit?

### Variables and Outputs
- **Defaults**: Are default values sensible? Should a variable require explicit input instead of having a default?
- **Types and validation**: Are variable types correct? Are there `validation` blocks where they'd help?
- **Descriptions**: Do variables and outputs have meaningful descriptions?
- **Sensitivity**: Are secrets marked `sensitive = true`?

### Modules
- **Source pinning**: Are module sources pinned to a specific version/ref, not `main` or `latest`?
- **Input completeness**: Are all required inputs provided? Are optional inputs intentionally omitted?
- **Output exposure**: Does the module expose outputs that callers need?

### Provider and Backend
- **Provider versions**: Are provider version constraints appropriate (`~>` for minor, `>=` for minimum)?
- **Backend config**: Is remote state configured correctly? Any risk of state conflicts?

### Data Sources
- **Filtering**: Are data source filters specific enough to return exactly one result?
- **Error handling**: What happens if the data source returns nothing?

### Common Mistakes
- Hardcoded values that should be variables
- Missing `tags` or inconsistent tagging
- Security groups that are too permissive (0.0.0.0/0)
- IAM policies that are broader than necessary
- Resources in the wrong region or account

## YAML / Helm / Kubernetes

### Structure
- **Indentation**: YAML is whitespace-sensitive — check for indentation errors, especially in nested structures
- **Anchors and aliases**: If used, are they correct? Are they making the file harder to understand?
- **Quoting**: Are values that look like booleans or numbers quoted when they should be strings? (`"true"` vs `true`, `"1234"` vs `1234`)

### Helm Charts
- **Values**: Are values parameterized appropriately? Anything hardcoded that should be in `values.yaml`?
- **Templates**: Do template conditionals handle missing values with `default` or `required`?
- **Chart version**: Is `Chart.yaml` version bumped appropriately?

### Kubernetes Resources
- **Resource limits**: Are CPU/memory requests and limits set? Are they reasonable?
- **Labels and selectors**: Are labels consistent? Do selectors match the right pods?
- **Service accounts**: Is the right service account specified?
- **ConfigMaps and Secrets**: Are referenced ConfigMaps/Secrets actually defined?
- **Probes**: Are liveness and readiness probes configured and appropriate?

## Monitoring / Alerting (Grafana, MMA, Prometheus)

### Dashboards
- **Panel queries**: Do PromQL/SQL queries return what's expected? Check label matchers.
- **Thresholds**: Are alert thresholds reasonable? Too sensitive causes alert fatigue; too loose misses incidents.
- **Variable templating**: Do dashboard variables work correctly across panels?
- **Time ranges**: Are default time ranges appropriate for the metric?

### Alert Rules
- **For duration**: Is the `for` clause long enough to avoid flapping but short enough to catch real issues?
- **Severity labels**: Is the severity appropriate for the impact?
- **Runbook links**: Do alerts link to a runbook or at least describe what to do?
- **Silencing/inhibition**: Could this alert conflict with existing alert rules?

## Application Code (Python, Go, Shell, etc.)

### General
- **Error handling**: Are errors caught, logged, and handled appropriately? No silent failures.
- **Input validation**: Is user/external input validated before use?
- **Security**: Secrets in code? SQL injection? Command injection? Path traversal?
- **Performance**: N+1 queries? Unnecessary loops? Missing caching where it would help?
- **Concurrency**: Race conditions? Deadlocks? Proper use of locks/mutexes?

### Python
- **Type hints**: Are they present and correct?
- **Exception handling**: Specific exceptions, not bare `except:`?
- **f-strings vs format**: Consistent string formatting?

### Shell Scripts
- **Quoting**: Are variables quoted (`"$var"` not `$var`)?
- **Error handling**: `set -euo pipefail` at the top?
- **Portability**: bash-isms in a script with `#!/bin/sh`?

### Go
- **Error handling**: All errors checked? No `_` for error returns that matter?
- **Goroutine leaks**: Are goroutines properly managed and cleaned up?
- **Context propagation**: Is `context.Context` passed through correctly?

## Documentation / Markdown

- **Accuracy**: Does the documentation match the current code, not a previous version?
- **Links**: Do all links resolve? Are relative paths correct?
- **Examples**: Are code examples runnable and correct?
- **Completeness**: Are new features/flags/options documented?
