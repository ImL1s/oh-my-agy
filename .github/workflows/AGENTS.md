<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# workflows

## Purpose

GitHub Actions workflow definitions.

## Key Files

| File | Description |
|------|-------------|
| `ci.yml` | Node 20/22 build + unit + pack smoke |
| `release.yml` | Tag `v*` → test + pack + GH Release + GitHub Packages |

## For AI Agents

### Working In This Directory

- Tag version assert: package.json ≡ plugin.json (and .claude-plugin when checked).
- Do not remove e2e from release without explicit product approval.

<!-- MANUAL: -->
