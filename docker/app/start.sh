#!/bin/sh
set -eu

attempt=1
max_attempts=20

until pnpm exec prisma db push; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "Prisma schema sync failed after $attempt attempts"
    exit 1
  fi

  echo "Waiting for database before starting app (attempt $attempt/$max_attempts)..."
  attempt=$((attempt + 1))
  sleep 3
done

exec node dist/main.js
