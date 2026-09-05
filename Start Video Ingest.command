#!/bin/bash
cd "$(dirname "$0")" || exit 1
/bin/bash scripts/macos.sh run
STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  read -r -p 'Press Return to close...'
fi
exit "$STATUS"
