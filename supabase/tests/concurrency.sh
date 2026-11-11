#!/bin/bash
# Fires N simultaneous booking requests (N different customers, N separate
# database connections) at the SAME court and time. Exactly one may succeed.
# Usage: PSQL="psql -h host -p port -U user -d db" ./concurrency.sh [N]
PSQL=${PSQL:-"psql -h /tmp/pg -p 5433 -U postgres -d yepjo"}
N=${1:-20}
$PSQL -q -v ON_ERROR_STOP=1 <<SQL
insert into auth.users (id, email, raw_user_meta_data)
select gen_random_uuid(), 'race' || g || '@example.test', '{"full_name":"Race Tester"}' from generate_series(1, $N) g;
update profiles set phone = '+639170000000', completed_at = now() where email like 'race%@example.test';
SQL
SLOT=$($PSQL -At -c "select (((now() at time zone 'Asia/Manila')::date + 3 + time '18:00') at time zone 'Asia/Manila')")
COURT=$($PSQL -At -c "select id from courts where sport='pickleball' order by sort_order limit 1")
# every session sleeps until the same instant, then books
GO=$($PSQL -At -c "select clock_timestamp() + interval '3 seconds'")
for uid in $($PSQL -At -c "select id from profiles where email like 'race%@example.test'"); do
  $PSQL -At -q 2>&1 <<SQL &
select pg_sleep(greatest(0, extract(epoch from ('$GO'::timestamptz - clock_timestamp()))));
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"$uid"}', true);
select 'BOOKED ' || (book_court($COURT, '$SLOT', 120)).reference;
commit;
SQL
done > /tmp/pg/race.out
wait
echo "requests:            $N (court $COURT, $SLOT, 2 hours)"
echo "confirmed responses: $(grep -c '^BOOKED' /tmp/pg/race.out)"
echo "SLOT_TAKEN responses: $(grep -c 'SLOT_TAKEN' /tmp/pg/race.out)"
echo "rows in database:    $($PSQL -At -c "select count(*) from reservations where court_id=$COURT and starts_at='$SLOT' and status='confirmed'")"
$PSQL -q -c "delete from reservations where customer_email like 'race%@example.test'" -c "delete from auth.users where email like 'race%@example.test'"
