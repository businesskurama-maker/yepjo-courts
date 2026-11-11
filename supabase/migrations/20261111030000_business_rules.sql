-- Yepjo business rules: PHP 300 per hour, 1 to 12 hour bookings,
-- self-service cancellation up to 6 hours before the start time.

update public.settings
   set slot_minutes        = 60,
       min_slots           = 1,
       max_slots           = 12,
       allow_cancellation  = true,
       cancel_cutoff_hours = 6,
       cancellation_note   = 'You can cancel in the app up to 6 hours before your booking. Within 6 hours, please call or message Yepjo to cancel.',
       rates_confirmed     = true,
       policy_confirmed    = true
 where id;

update public.courts set hourly_rate = 300;

alter table public.settings alter column max_slots set default 12;
alter table public.settings alter column cancel_cutoff_hours set default 6;
alter table public.courts alter column hourly_rate set default 300;
