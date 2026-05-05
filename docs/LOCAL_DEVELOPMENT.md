# Local Documentation Development

This guide explains how to work with the documentation locally.

## Prerequisites

Install MkDocs and the Material theme:

```bash
pip install mkdocs mkdocs-material
```

Or using a virtual environment (recommended):

```bash
# Create virtual environment
python -m venv venv

# Activate it
source venv/bin/activate  # On macOS/Linux
# or
venv\Scripts\activate     # On Windows

# Install dependencies
pip install mkdocs mkdocs-material
```

## Quick Start

### Serve Documentation Locally

```bash
# Using npm script (recommended)
npm run docs:serve

# Or directly with mkdocs
mkdocs serve
```

This will start a local server at **http://127.0.0.1:8000/**

The server will automatically reload when you make changes to the documentation files.

### Build Documentation

To build the static site (outputs to `site/` directory):

```bash
# Using npm script
npm run docs:build

# Or directly with mkdocs
mkdocs build
```

### Deploy to GitHub Pages

To deploy the documentation to GitHub Pages:

```bash
# Using npm script
npm run docs:deploy

# Or directly with mkdocs
mkdocs gh-deploy
```

## Documentation Structure

```
docs/
├── index.md                          # Home page
├── getting-started.md                # Getting started guide
├── how-it-works.md                   # How the generator works
├── configuration.md                  # Configuration reference
├── mcp-configuration.md              # MCP server configuration
├── deployments.md                    # Deployment targets & inference
├── ci-integration.md                 # CI integration harness
├── EXAMPLES.md                       # Usage examples
├── TROUBLESHOOTING.md                # Troubleshooting guide
├── CONTRIBUTING.md                   # Contributing guide
├── architecture.md                   # Architecture overview
├── dev/
│   ├── generator-architecture.md     # Generator internals
│   ├── template-system.md            # EJS templates & do/ scripts
│   ├── mcp-server-development.md     # MCP server development
│   ├── registries-and-catalogs.md    # Catalog JSON format & data flow
│   └── testing.md                    # Testing guide
├── snippets/
│   ├── ai-frameworks-table.md        # Reusable table snippets
│   ├── architecture-diagram.md
│   ├── framework-table.md
│   ├── ml-frameworks-table.md
│   └── web-server-table.md
├── stylesheets/
│   └── extra.css                     # Custom styles
└── logo.png                          # Project logo
```

The canonical navigation structure is defined in `mkdocs.yml`. Pages not listed in the nav are excluded from the built site.

## Making Changes

### 1. Edit Documentation Files

Documentation files are in the `docs/` directory and use Markdown format.

### 2. Preview Changes

Start the local server to see your changes in real-time:

```bash
npm run docs:serve
```

### 3. Check for Broken Links

MkDocs will warn you about broken internal links when building. Use `--strict` to treat warnings as errors:

```bash
mkdocs build --strict
```

### 4. Test the Build

Before deploying, always test the build locally:

```bash
# Build the site
npm run docs:build

# Serve the built site
cd site
python -m http.server 8000
```

## MkDocs Configuration

The documentation is configured in `mkdocs.yml`:

- **Theme**: Material for MkDocs
- **Features**: Navigation tabs, search, code highlighting
- **Extensions**: Admonitions, code blocks, tables, etc.

## Common Tasks

### Add a New Page

1. Create a new `.md` file in `docs/`
2. Add it to the navigation in `mkdocs.yml`:

```yaml
nav:
  - Home: index.md
  - Your New Page: your-new-page.md
```

### Add Images

1. Place images in `docs/` directory
2. Reference them in Markdown:

```markdown
![Alt text](image.png)
```

### Add Code Blocks

Use fenced code blocks with language specification:

````markdown
```python
def hello():
    print("Hello, world!")
```
````

### Add Admonitions

Use admonitions for notes, warnings, etc.:

```markdown
!!! note
    This is a note.

!!! warning
    This is a warning.

!!! tip
    This is a tip.
```

### Add Mermaid Diagrams

Use fenced code blocks with the `mermaid` language:

````markdown
```mermaid
graph TD
    A[Start] --> B[End]
```
````

### Add Tabbed Content

Use tabbed blocks for alternative instructions:

```markdown
=== "macOS/Linux"

    ```bash
    source venv/bin/activate
    ```

=== "Windows"

    ```bash
    venv\Scripts\activate
    ```
```

### Include Snippets

Reusable content lives in `docs/snippets/`. Include them with:

```markdown
--8<-- "framework-table.md"
```

## Troubleshooting

### MkDocs Not Found

If you get "command not found: mkdocs":

```bash
# Make sure it's installed
pip install mkdocs mkdocs-material

# Or check if it's in your PATH
which mkdocs
```

### Port Already in Use

If port 8000 is already in use:

```bash
# Use a different port
mkdocs serve -a localhost:8001
```

### Changes Not Showing

If changes aren't showing up:

1. Hard refresh your browser (Cmd+Shift+R on Mac, Ctrl+Shift+R on Windows)
2. Clear browser cache
3. Restart the MkDocs server

### Build Errors

If you get build errors:

1. Check for syntax errors in Markdown files
2. Verify all referenced files exist
3. Check `mkdocs.yml` for configuration errors

## Resources

- [MkDocs Documentation](https://www.mkdocs.org/)
- [Material for MkDocs](https://squidfunk.github.io/mkdocs-material/)
- [Markdown Guide](https://www.markdownguide.org/)

## GitHub Pages Deployment

The documentation is automatically deployed to GitHub Pages when you run:

```bash
npm run docs:deploy
```

This will:
1. Build the documentation
2. Push it to the `gh-pages` branch
3. GitHub will automatically serve it at: https://awslabs.github.io/ml-container-creator/

### Manual Deployment

If automatic deployment doesn't work:

```bash
# Build the site
mkdocs build

# The built site is in the site/ directory
# You can manually push this to the gh-pages branch
```

## Tips

1. **Use Live Reload**: Keep `mkdocs serve` running while editing
2. **Check Links**: Always build before deploying to catch broken links
3. **Test Locally**: Test the built site before deploying
4. **Use Admonitions**: Make important information stand out
5. **Add Code Examples**: Include practical examples in documentation
6. **Keep It Updated**: Update docs when adding features

## NPM Scripts Reference

```bash
npm run docs:serve   # Start local documentation server
npm run docs:build   # Build static documentation site
npm run docs:deploy  # Deploy to GitHub Pages
```
