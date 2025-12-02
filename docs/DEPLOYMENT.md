# Documentation Deployment Guide

This guide explains how documentation is deployed for ML Container Creator.

## Automatic Deployment via GitHub Actions

Documentation is **automatically deployed** to GitHub Pages when changes are pushed to the `main` branch.

### How It Works

1. **Trigger**: Push to `main` branch or create a pull request
2. **Build**: GitHub Actions runs `mkdocs build --strict`
3. **Deploy**: Built site is deployed to GitHub Pages (main branch only)
4. **Live**: Documentation is available at https://awslabs.github.io/ml-container-creator/

### Workflow Configuration

The deployment workflow is defined in `.github/workflows/docs.yml`:

```yaml
name: Deploy MkDocs to GitHub Pages

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  build:
    # Builds documentation on every push/PR
    
  deploy:
    # Deploys only on main branch
```

## Local Development

### Testing Locally

Before pushing changes, always test locally:

```bash
# Serve with live reload
./scripts/docs.sh serve

# Build in strict mode (same as CI)
./scripts/docs.sh build
```

### Build Output

The `site/` directory contains the built documentation:
- ✅ **Ignored by git** (in `.gitignore`)
- ✅ **Generated locally** for testing
- ✅ **Built by CI** for deployment

**Never commit the `site/` directory!**

## Making Documentation Changes

### Standard Workflow

1. **Edit documentation** in `docs/` directory
2. **Test locally**: `./scripts/docs.sh serve`
3. **Build to verify**: `./scripts/docs.sh build`
4. **Commit changes**: `git add docs/ && git commit -m "Update docs"`
5. **Push to main**: `git push origin main`
6. **Wait for deployment**: GitHub Actions will deploy automatically

### Syncing Steering Files

Some documentation files are synced from other locations:

```bash
# Sync all steering files to docs
./scripts/docs.sh sync
```

This syncs:
- `generators/app/templates/README.md` → `docs/template-system.md`

**Note**: `generators/app/templates/README.md` is documentation about the template system itself and is excluded from being copied to generated projects.

## Monitoring Deployments

### Check Deployment Status

1. Go to your repository on GitHub
2. Click the **Actions** tab
3. Find the "Deploy MkDocs to GitHub Pages" workflow
4. Check the status of recent runs

### View Deployment Logs

Click on any workflow run to see:
- Build logs
- Deployment status
- Any errors or warnings

### Troubleshooting Failed Deployments

If deployment fails:

1. **Check the workflow logs** in GitHub Actions
2. **Test locally** with `./scripts/docs.sh build`
3. **Fix any errors** shown in strict mode
4. **Push the fix** and deployment will retry

Common issues:
- Broken internal links
- Missing files referenced in documentation
- Markdown syntax errors
- Invalid YAML in `mkdocs.yml`

## Security

### Why No Manual Deployment?

Manual deployment via `mkdocs gh-deploy` is **not available** for security reasons:

- ❌ Requires write access to the repository
- ❌ Can be run by anyone with the script
- ❌ Bypasses code review and CI checks

Instead, we use GitHub Actions which:

- ✅ Runs in a secure, isolated environment
- ✅ Requires proper permissions
- ✅ Goes through code review (via PRs)
- ✅ Provides audit logs

### Repository Settings

Ensure GitHub Pages is configured correctly:

1. Go to **Settings** → **Pages**
2. **Source**: GitHub Actions
3. **Branch**: Deployed from `gh-pages` (managed by Actions)

## Best Practices

### Before Pushing

- ✅ Test locally with `./scripts/docs.sh serve`
- ✅ Build in strict mode: `./scripts/docs.sh build`
- ✅ Check for broken links
- ✅ Verify all images load correctly
- ✅ Test on mobile viewport

### Writing Documentation

- Use relative links for internal pages
- Include code examples where helpful
- Add admonitions for important notes
- Keep navigation depth reasonable
- Test all external links

### Pull Requests

For documentation changes:

1. Create a feature branch
2. Make your changes
3. Test locally
4. Create a PR to `main`
5. GitHub Actions will build (but not deploy) for preview
6. After merge, deployment happens automatically

## Resources

- [MkDocs Documentation](https://www.mkdocs.org/)
- [Material for MkDocs](https://squidfunk.github.io/mkdocs-material/)
- [GitHub Pages Documentation](https://docs.github.com/en/pages)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
