#!/bin/bash
cd "$(dirname "$0")" || exit 1
/bin/bash scripts/macos.sh build
STATUS=$?
read -r -p 'Press Return to close...'
exit "$STATUS"
