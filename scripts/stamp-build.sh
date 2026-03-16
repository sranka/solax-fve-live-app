#!/bin/sh
# Generates web/build-info.js with a SHA1 fingerprint of web/index.html.
# This file is loaded at runtime — index.html is never modified.

SHA1=$(shasum web/index.html | cut -c1-8)
BUILDTIME=$(date '+%Y-%m-%d %H:%M')

cat > web/build-info.js <<EOF
document.getElementById('buildFingerprint').textContent = 'build: $SHA1 ($BUILDTIME)';
EOF

echo "Generated build-info.js with fingerprint: $SHA1 ($BUILDTIME)"
