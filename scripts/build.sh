#!/bin/bash

# Build script for Chrome Web Store publishing
# - Bumps minor version in manifest.json
# - Creates a zip package in build/

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT_DIR/build"
MANIFEST="$ROOT_DIR/manifest.json"

# Read current version
CURRENT_VERSION=$(grep '"version"' "$MANIFEST" | sed -E 's/.*"version": "([^"]+)".*/\1/')
echo "Current version: $CURRENT_VERSION"

# Parse version parts (major.minor.patch)
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

# Bump minor version, reset patch to 0
NEW_MINOR=$((MINOR + 1))
NEW_VERSION="$MAJOR.$NEW_MINOR.0"
echo "New version: $NEW_VERSION"

# Update manifest.json
sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$MANIFEST"

# Create build directory
mkdir -p "$BUILD_DIR"

# Create zip (exclude unnecessary files)
ZIP_NAME="portfolio-overlay-v$NEW_VERSION.zip"
cd "$ROOT_DIR"
zip -r "$BUILD_DIR/$ZIP_NAME" \
  manifest.json \
  src/ \
  publishing/icons/icon16.png \
  publishing/icons/icon48.png \
  publishing/icons/icon128.png \
  -x "*.DS_Store"

echo ""
echo "Build complete!"
echo "  Version: $NEW_VERSION"
echo "  Package: build/$ZIP_NAME"
