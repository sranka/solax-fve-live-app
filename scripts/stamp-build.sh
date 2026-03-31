#!/bin/sh
# Generates web/build-info.js with a SHA1 fingerprint of web/index.html.
# This file is loaded at runtime — index.html is never modified.

VERSION=$(node -p "require('./package.json').version")
SHA1=$(cat web/index.html web/sw.js | shasum | cut -c1-8)
BUILDTIME=$(date '+%Y-%m-%d %H:%M')

cat > web/build-info.js <<EOF
document.getElementById('buildFingerprint').textContent = 'build: v$VERSION $SHA1 ($BUILDTIME) ' + screen.width + 'x' + screen.height;
EOF

echo "Generated build-info.js with fingerprint: v$VERSION $SHA1 ($BUILDTIME)"
