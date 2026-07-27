#!/usr/bin/env sh
set -eu

API="${API:-http://localhost:3000}"
PHONE="+919999999999"

request=$(curl -sS -X POST "$API/v1/auth/otp/request" -H 'content-type: application/json' -d "{\"phone\":\"$PHONE\"}")
code=$(printf '%s' "$request" | python3 -c 'import json,sys; print(json.load(sys.stdin)["developmentOtp"])')
verify=$(curl -sS -X POST "$API/v1/auth/otp/verify" -H 'content-type: application/json' -d "{\"phone\":\"$PHONE\",\"code\":\"$code\",\"name\":\"Smoke Test\"}")
token=$(printf '%s' "$verify" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')

curl -sS "$API/v1/me" -H "authorization: Bearer $token" | python3 -m json.tool
