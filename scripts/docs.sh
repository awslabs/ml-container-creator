#!/bin/bash
# Documentation management script for ML Container Creator
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

case "${1:-help}" in
    "build")
        echo "🔨 Building documentation..."
        mkdocs build --strict
        echo "✅ Documentation built successfully!"
        echo "📁 Output: site/"
        ;;
    
    "serve")
        echo "🚀 Starting documentation server..."
        echo "📖 Open http://localhost:8000/ml-container-creator/ in your browser"
        mkdocs serve
        ;;
    
    "sync")
        echo "🔄 Syncing template documentation to docs..."
        cp generators/app/templates/README.md docs/template-system.md
        echo "✅ Files synced!"
        ;;
    
    "clean")
        echo "🧹 Cleaning documentation build..."
        rm -rf site/
        echo "✅ Clean complete!"
        ;;
    
    "help"|*)
        echo "📚 ML Container Creator Documentation Helper"
        echo ""
        echo "Usage: $0 <command>"
        echo ""
        echo "Commands:"
        echo "  build   - Build documentation (strict mode)"
        echo "  serve   - Serve documentation locally"
        echo "  sync    - Sync template documentation to docs"
        echo "  clean   - Clean build artifacts"
        echo "  help    - Show this help"
        echo ""
        echo "Examples:"
        echo "  $0 serve    # Start local server"
        echo "  $0 build    # Build static site"
        echo ""
        echo "Note: Documentation is automatically deployed to GitHub Pages"
        echo "      via GitHub Actions when changes are pushed to main."
        ;;
esac
