# Documentation

This directory contains the source files for the ML Container Creator documentation, built with [MkDocs](https://www.mkdocs.org/) and the [Material theme](https://squidfunk.github.io/mkdocs-material/).

## Structure

```
docs/
├── index.md                 # Home page
├── getting-started.md       # Installation and first project tutorial
├── EXAMPLES.md             # Framework-specific examples
├── TROUBLESHOOTING.md      # Common issues and solutions
├── CONTRIBUTING.md         # Quick contributor guide
├── ADDING_FEATURES.md      # Detailed feature development guide
├── template-system.md      # Template documentation
├── architecture.md         # Complete architecture guide
├── coding-standards.md     # Code style guide
├── aws-sagemaker.md       # AWS/SageMaker context
├── DEPLOYMENT.md           # Deployment guide
├── logo.png               # Project logo
└── stylesheets/
    └── extra.css          # Custom CSS
```

## Working with Documentation

### Local Development

```bash
# Serve docs locally with live reload
./scripts/docs.sh serve

# Or use mkdocs directly
mkdocs serve
```

Then open http://localhost:8000/ml-container-creator/ in your browser.

### Building

```bash
# Build static site
./scripts/docs.sh build

# Or use mkdocs directly
mkdocs build --strict
```

The built site will be in the `site/` directory.

### Syncing Documentation Files

Some documentation files are synced from source files:

- `template-system.md` ← `generators/app/templates/README.md`

To sync these files:

```bash
./scripts/docs.sh sync
```

**Note**: `generators/app/templates/README.md` documents the template system and is excluded from being copied to generated projects (see `generators/app/index.js`).

### Deploying

Documentation is automatically deployed to GitHub Pages via GitHub Actions when changes are pushed to the `main` branch.

The workflow is defined in `.github/workflows/docs.yml` and will:
1. Build the documentation with `mkdocs build --strict`
2. Upload the built site as an artifact
3. Deploy to GitHub Pages (only on main branch)

No manual deployment is needed - just push your changes!

## Writing Documentation

### Markdown Extensions

The documentation supports many markdown extensions:

- **Admonitions**: `!!! note`, `!!! warning`, `!!! tip`
- **Code blocks**: With syntax highlighting and copy buttons
- **Tabs**: For showing multiple options
- **Tables**: Standard markdown tables
- **Emojis**: `:smile:` → 😊
- **Mermaid diagrams**: For flowcharts and diagrams

See the [Material for MkDocs documentation](https://squidfunk.github.io/mkdocs-material/reference/) for more details.

### Style Guide

- Use clear, concise language
- Include code examples where helpful
- Use admonitions to highlight important information
- Keep navigation depth reasonable (max 3 levels)
- Test all links before committing

### Internal Links

Use relative links for internal documentation:

```markdown
[Getting Started](getting-started.md)
[Examples](EXAMPLES.md#sklearn-example)
```

For external links to the repository:

```markdown
[CONTRIBUTING](https://github.com/awslabs/ml-container-creator/blob/main/CONTRIBUTING.md)
```

## Configuration

The documentation is configured in `mkdocs.yml` at the project root. Key settings:

- **Theme**: Material with dark/light mode toggle
- **Navigation**: Organized into Home, Getting Started, User Guide, and Developer Guide
- **Features**: Search, code copy, navigation tracking
- **Extensions**: Admonitions, code highlighting, tabs, and more

## Troubleshooting

### Build Warnings

If you see warnings about missing links:

```bash
mkdocs build --strict
```

This will fail on any warnings, helping you catch broken links.

### Logo Not Showing

Make sure `logo.png` exists in the `docs/` directory. It should be copied from the project root.

### Styles Not Applied

Check that `docs/stylesheets/extra.css` exists and is referenced in `mkdocs.yml`.

## Resources

- [MkDocs Documentation](https://www.mkdocs.org/)
- [Material for MkDocs](https://squidfunk.github.io/mkdocs-material/)
- [Markdown Guide](https://www.markdownguide.org/)
