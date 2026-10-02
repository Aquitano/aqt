#!/bin/sh
# Runs in the compose `backup` service. Checks hourly instead of sleeping for a
# day: time the laptop spends asleep does not count towards a sleep in the
# container, so a day-long one would drift by every night. A dump gets its
# final name only once pg_dump has succeeded.
set -u

keep=3
# A dump holds every page read; on the VPS only root reads it.
umask 077

while :; do
	if [ -z "$(find /backups -maxdepth 1 -name 'tracker-*.dump' -mmin -1380)" ]; then
		file="/backups/tracker-$(date -u +%Y%m%dT%H%M%SZ).dump"
		if pg_dump -h db -U tracker -d tracker -Fc -f "$file.partial"; then
			mv "$file.partial" "$file"
			ls -1 /backups/tracker-*.dump | head -n -"$keep" | xargs -r rm -f
			echo "backup: wrote $file"
		else
			rm -f "$file.partial"
			echo "backup: pg_dump failed, retrying in an hour" >&2
		fi
	fi
	sleep 3600
done
