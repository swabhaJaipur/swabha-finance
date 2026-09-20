#!/bin/sh
# Swabha Financial Control System — start the server.
cd "$(dirname "$0")"
exec node server/server.js
