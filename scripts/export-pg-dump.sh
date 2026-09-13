#!/usr/bin/env bash
# PropertyTour360: PostgreSQL Data Export & CockroachDB Import Script
set -euo pipefail

PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-propertytour}"
PG_DB="${PG_DB:-propertytour360}"
PG_PASSWORD="${PG_PASSWORD:-propertytour_dev_password}"

CR_HOST="${CR_HOST:-localhost}"
CR_PORT="${CR_PORT:-26257}"
CR_DB="${CR_DB:-propertytour360}"
CR_USER="${CR_USER:-root}"

DUMP_FILE="${1:-postgres_data_export.sql}"

echo "======================================================"
echo "  PropertyTour360 SQL Dump Exporter & Importer"
echo "======================================================"
echo "Source:  postgresql://${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_DB}"
echo "Target:  postgresql://${CR_USER}@${CR_HOST}:${CR_PORT}/${CR_DB}"
echo "Output:  ${DUMP_FILE}"
echo "======================================================"

# 1. Export data from PostgreSQL
echo "[1/2] Exporting data from PostgreSQL (data-only, column inserts)..."
PGPASSWORD="${PG_PASSWORD}" pg_dump \
  -h "${PG_HOST}" \
  -p "${PG_PORT}" \
  -U "${PG_USER}" \
  -d "${PG_DB}" \
  --data-only \
  --column-inserts \
  --no-owner \
  --no-privileges \
  -f "${DUMP_FILE}"

echo "✓ Export successful: ${DUMP_FILE} ($(du -h "${DUMP_FILE}" | cut -f1))"

# 2. Restore into CockroachDB
echo "[2/2] You can import this file into CockroachDB via:"
echo "      cockroach sql --insecure --host=${CR_HOST}:${CR_PORT} --database=${CR_DB} < ${DUMP_FILE}"
echo "      OR"
echo "      psql 'postgresql://${CR_USER}@${CR_HOST}:${CR_PORT}/${CR_DB}?sslmode=disable' -f ${DUMP_FILE}"
echo "======================================================"
