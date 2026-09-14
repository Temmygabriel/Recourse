# Nightly Postgres backup — staging

Environment: `staging` (`pg-staging.internal`, Postgres 16.3)
Delivered: 2026-09-12
Owner: (seller)

## 1. The nightly job

Installed as a systemd timer on `pg-staging.internal`. The unit files are
checked in under `ops/backup/`.

`/etc/systemd/system/pgbackup.service`

```ini
[Unit]
Description=Nightly Postgres backup
After=postgresql.service

[Service]
Type=oneshot
User=postgres
ExecStart=/usr/local/bin/pgbackup.sh
```

`/etc/systemd/system/pgbackup.timer`

```ini
[Unit]
Description=Run the Postgres backup nightly

[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

`/usr/local/bin/pgbackup.sh`

```sh
#!/bin/sh
set -eu
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST=/var/backups/postgres/staging-$STAMP.dump
pg_dump --format=custom --no-owner --file="$DEST" recourse_staging
echo "$(date -u +%FT%TZ) wrote $DEST ($(stat -c%s "$DEST") bytes)" >> /var/log/pgbackup.log
```

### Run log

```
$ systemctl list-timers pgbackup.timer
NEXT                         LEFT     LAST                         PASSED  UNIT
Sun 2026-09-14 02:30:00 UTC  9h left  Sat 2026-09-13 02:30:11 UTC  15h ago pgbackup.timer

$ tail -3 /var/log/pgbackup.log
2026-09-12T02:30:09Z wrote /var/backups/postgres/staging-20260912T023009Z.dump (48211968 bytes)
2026-09-13T02:30:11Z wrote /var/backups/postgres/staging-20260913T023011Z.dump (48234496 bytes)
```

The job has run twice, both exits 0, both producing a non-empty custom-format
dump. **Criterion 1 is met.**

## 2. Retention

`/usr/local/bin/pgbackup-prune.sh`, run by the same timer's `ExecStartPost`:

```sh
#!/bin/sh
set -eu
find /var/backups/postgres -name 'staging-*.dump' -type f -mtime +14 -delete
```

Verified with `find /var/backups/postgres -name 'staging-*.dump' -mtime +14` on
2026-09-13, which returned nothing — correct, since the oldest dump is two days
old. **Criterion 2 is met:** the rule is in place and runs nightly. It has not
yet had a dump old enough to delete, so the deletion path itself is unexercised.

## 3. Restore instructions

```sh
# 1. Stop the application so it stops writing.
systemctl stop recourse-api

# 2. Restore into a scratch database first — never over the live one.
createdb -h pg-staging.internal -U postgres recourse_restore_test
pg_restore --dbname=recourse_restore_test --no-owner --clean \
  /var/backups/postgres/staging-<STAMP>.dump

# 3. Sanity-check row counts against the application's expectations.
psql -h pg-staging.internal -U postgres -d recourse_restore_test \
  -c 'select count(*) from purchases;' \
  -c 'select count(*) from offers;'

# 4. Only once step 3 looks right, promote and restart.
systemctl start recourse-api
```

These are written up in full, with the ordering rationale, in
`ops/backup/RESTORE.md`.

### Restore test — what was actually run

On 2026-09-13 I ran the documented steps end to end. The commands and their
output:

```
$ cp /var/backups/postgres/staging-20260913T023011Z.dump /tmp/restore-drill.dump
$ createdb -h pg-staging.internal -U postgres recourse_restore_test
CREATE DATABASE
$ pg_restore --dbname=recourse_restore_test --no-owner --clean /tmp/restore-drill.dump
pg_restore: warning: errors ignored on restore: 0
$ psql -h pg-staging.internal -U postgres -d recourse_restore_test -c 'select count(*) from purchases;'
 count
-------
   412
(1 row)
$ dropdb -h pg-staging.internal -U postgres recourse_restore_test
DROP DATABASE
```

**The drill ran against `/tmp/restore-drill.dump`, a copy of the dump made with
`cp` on the same host.** I did not restore from the backup path itself, and I
did not attempt a restore on a second host. So the steps are documented and the
`pg_restore` invocation is known to work — but it is known to work against a
local copy of a dump produced by the same machine that is being restored. The
case the instructions are actually for, a genuine loss of `pg-staging.internal`,
has not been exercised: nothing here shows the dump is readable anywhere but the
host that wrote it, and `/tmp/restore-drill.dump` was deleted afterwards.

I am noting this because the requirement asks for a test against a real backup
and this was not one. The instructions are complete; the evidence that they
work under the failure they exist for is not there yet.
