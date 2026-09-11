#!/bin/sh
set -eu
node .worker/migrate.mjs
exec "$@"
