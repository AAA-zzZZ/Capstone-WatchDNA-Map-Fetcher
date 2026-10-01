#!/bin/bash
# =============================================================
# Analytics Pipeline Test Script
# Tests event ingestion + admin query endpoints
# =============================================================
# Usage:
#   ./test-analytics.sh                         # defaults to localhost:3001
#   ./test-analytics.sh https://your-app.up.railway.app
# =============================================================

API_BASE="${1:-http://localhost:3001}"
PASS=0
FAIL=0

green() { printf "\033[32m✓ %s\033[0m\n" "$1"; PASS=$((PASS+1)); }
red()   { printf "\033[31m✗ %s\033[0m\n" "$1"; FAIL=$((FAIL+1)); }

echo ""
echo "Testing analytics at: $API_BASE"
echo "============================================="

# -----------------------------------------------
# 1. Test single event ingestion
# -----------------------------------------------
echo ""
echo "--- Phase 1: Event Ingestion ---"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$API_BASE/api/analytics/events" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "store_tapped",
    "properties": {"storeId": "test-001", "storeName": "Test Jewelers", "brands": "Rolex,Omega", "city": "Toronto", "country": "Canada", "isPremium": true, "source": "store_locator"},
    "sessionId": "test-session-001",
    "deviceType": "ios"
  }')

[ "$STATUS" = "201" ] && green "Single event POST → 201" || red "Single event POST → $STATUS (expected 201)"

# -----------------------------------------------
# 2. Test batch event ingestion
# -----------------------------------------------
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$API_BASE/api/analytics/events/batch" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [
      {"event": "screen_viewed", "properties": {"screen": "store_locator"}, "sessionId": "test-session-001", "deviceType": "ios"},
      {"event": "screen_viewed", "properties": {"screen": "search_directory"}, "sessionId": "test-session-002", "deviceType": "android"},
      {"event": "store_tapped", "properties": {"storeId": "test-002", "storeName": "Crown Watch Co", "city": "Vancouver"}, "sessionId": "test-session-001", "deviceType": "ios"},
      {"event": "store_phone_tapped", "properties": {"storeId": "test-001", "storeName": "Test Jewelers"}, "sessionId": "test-session-001", "deviceType": "ios"},
      {"event": "store_directions_tapped", "properties": {"storeId": "test-001", "storeName": "Test Jewelers"}, "sessionId": "test-session-002", "deviceType": "android"},
      {"event": "store_website_tapped", "properties": {"storeId": "test-002", "storeName": "Crown Watch Co", "url": "https://crownwatch.co"}, "sessionId": "test-session-002", "deviceType": "android"},
      {"event": "store_email_tapped", "properties": {"storeId": "test-001", "storeName": "Test Jewelers"}, "sessionId": "test-session-001", "deviceType": "ios"},
      {"event": "brand_searched", "properties": {"query": "rolex"}, "sessionId": "test-session-001", "deviceType": "ios"},
      {"event": "brand_searched", "properties": {"query": "omega"}, "sessionId": "test-session-002", "deviceType": "android"},
      {"event": "brand_searched", "properties": {"query": "rolex"}, "sessionId": "test-session-003", "deviceType": "ios"},
      {"event": "brand_viewed", "properties": {"brandId": "1", "brandName": "Rolex", "source": "search_directory"}, "sessionId": "test-session-001", "deviceType": "ios"},
      {"event": "brand_viewed", "properties": {"brandId": "2", "brandName": "Omega", "source": "search_directory"}, "sessionId": "test-session-002", "deviceType": "android"}
    ]
  }')

[ "$STATUS" = "201" ] && green "Batch event POST (12 events) → 201" || red "Batch event POST → $STATUS (expected 201)"

# -----------------------------------------------
# 3. Test validation — missing event field
# -----------------------------------------------
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$API_BASE/api/analytics/events" \
  -H "Content-Type: application/json" \
  -d '{"properties": {"foo": "bar"}}')

[ "$STATUS" = "400" ] && green "Missing event field → 400" || red "Missing event field → $STATUS (expected 400)"

# -----------------------------------------------
# 4. Test validation — empty batch
# -----------------------------------------------
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$API_BASE/api/analytics/events/batch" \
  -H "Content-Type: application/json" \
  -d '{"events": []}')

[ "$STATUS" = "400" ] && green "Empty batch → 400" || red "Empty batch → $STATUS (expected 400)"

# -----------------------------------------------
# 5. Test admin endpoints (need auth token)
# -----------------------------------------------
echo ""
echo "--- Phase 2: Admin Query Endpoints ---"
echo "(Logging in to get auth token...)"

LOGIN_RESP=$(curl -s -X POST "$API_BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "admin123"}')

TOKEN=$(echo "$LOGIN_RESP" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  red "Login failed — cannot test admin endpoints. Response: $LOGIN_RESP"
  echo ""
  echo "If admin user doesn't exist, run: npm run seed-admin"
  echo "Or adjust username/password above."
  echo ""
else
  green "Login successful — got auth token"

  # Test each admin endpoint
  for ENDPOINT in summary retailers brands actions sources daily; do
    RESP=$(curl -s -w "\n%{http_code}" \
      -H "Authorization: Bearer $TOKEN" \
      "$API_BASE/api/analytics/$ENDPOINT?days=30")

    STATUS=$(echo "$RESP" | tail -1)
    BODY=$(echo "$RESP" | sed '$d')

    if [ "$STATUS" = "200" ]; then
      green "GET /analytics/$ENDPOINT → 200"
      echo "    Response: $(echo "$BODY" | head -c 120)..."
    else
      red "GET /analytics/$ENDPOINT → $STATUS (expected 200)"
      echo "    Response: $BODY"
    fi
  done
fi

# -----------------------------------------------
# 6. Test that unauthenticated admin requests fail
# -----------------------------------------------
echo ""
echo "--- Phase 3: Auth Protection ---"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$API_BASE/api/analytics/summary")

[ "$STATUS" = "401" ] && green "Unauthenticated GET /summary → 401" || red "Unauthenticated GET /summary → $STATUS (expected 401)"

# -----------------------------------------------
# Results
# -----------------------------------------------
echo ""
echo "============================================="
echo "Results: $PASS passed, $FAIL failed"
echo "============================================="
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
