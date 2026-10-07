#!/bin/bash
# Fardar sends delivery status updates to a public web address, which this
# machine doesn't have — an ngrok tunnel gives it one. The server only lets
# tunnel traffic reach /api/webhooks (see src/index.ts), never the rest of
# the app.
#
#   npm run tunnel       start the tunnel (leave it running next to the server)
#   npm run tunnel:url   print the callback address to enter in Fardar's panel
cd "${BASH_SOURCE[0]%/*}/.."

# Plain bash only: a PATH with a broken `head`/`cut` (XAMPP ships some) can't break this.
get() {
  local line
  while IFS= read -r line; do
    case "$line" in "$1="*) printf '%s' "${line#*=}"; return ;; esac
  done < .env
}
DOMAIN="$(get NGROK_DOMAIN)"
SECRET="$(get FARDAR_WEBHOOK_SECRET)"

if [ -z "$DOMAIN" ]; then
  echo "NGROK_DOMAIN isn't set in server/.env yet — add your ngrok static domain (no https://)." >&2
  exit 1
fi
if [ "$1" = "url" ]; then
  [ -z "$SECRET" ] && { echo "FARDAR_WEBHOOK_SECRET isn't set in server/.env." >&2; exit 1; }
  echo "https://$DOMAIN/api/webhooks/fardar/$SECRET"
  exit 0
fi

NGROK="$(command -v ngrok || true)"
[ -z "$NGROK" ] && [ -x "$HOME/.local/bin/ngrok" ] && NGROK="$HOME/.local/bin/ngrok"
if [ -z "$NGROK" ]; then
  echo "ngrok isn't installed (looked on PATH and in ~/.local/bin)." >&2
  exit 1
fi
exec "$NGROK" http --url="$DOMAIN" "${PORT:-4000}"
