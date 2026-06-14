#!/bin/bash
# Trigger full schedule sync for all active users
# Usage: ./scripts/admin-refresh-all.sh [url]
# Default: https://schedule.cqu.moe
# Requires: ADMIN_SECRET environment variable

set -euo pipefail

if [ -z "${ADMIN_SECRET:-}" ]; then
  echo "Error: ADMIN_SECRET environment variable is not set" >&2
  exit 1
fi

URL="${1:-https://schedule.cqu.moe}"

curl -s -X POST "$URL/api/v2/admin/refresh-all" \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" | python3 -m json.tool
