#!/bin/bash
# Runs once, on the brain database's first start, before schema.sql.
# If NOCODB_META_PASSWORD and NOCODB_RO_PASSWORD are set, creates a separate
# database for NocoDB's own metadata and a read-only role NocoDB uses to view
# agent_brain. Without them it does nothing (NocoDB is optional). To add NocoDB
# later, run the same statements by hand.
set -euo pipefail

if [ -z "${NOCODB_META_PASSWORD:-}" ] || [ -z "${NOCODB_RO_PASSWORD:-}" ]; then
  echo "NocoDB passwords not set: skipping the viewer roles"
  exit 0
fi

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v meta_pw="$NOCODB_META_PASSWORD" \
  -v ro_pw="$NOCODB_RO_PASSWORD" <<'EOSQL'
CREATE ROLE nocodb_meta LOGIN PASSWORD :'meta_pw';
CREATE DATABASE nocodb_meta OWNER nocodb_meta;

CREATE ROLE nocodb_ro LOGIN PASSWORD :'ro_pw';
-- Table-level SELECT grants are issued at the end of schema.sql.
EOSQL
