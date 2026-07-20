<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# .github

## Purpose

GitHub Actions CI and release automation for `@iml1s/oh-my-agy`.

## Key Files

None at this level beyond workflows.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `workflows/` | `ci.yml`, `release.yml` |

## For AI Agents

### Working In This Directory

- Release tags `v*` must equal package/plugin/.claude-plugin versions.
- Release runs unit + package + e2e, packs tarball, GH Release, GitHub Packages; npmjs optional.

### Testing Requirements

- Workflows are the source of truth for release gates; do not weaken e2e without product decision.

## Dependencies

### External

- GitHub Actions runners, `GITHUB_TOKEN`, optional `NPM_TOKEN`

<!-- MANUAL: -->
