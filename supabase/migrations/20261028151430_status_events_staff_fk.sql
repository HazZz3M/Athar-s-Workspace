-- Link status changes to the staff member who made them, so the app can show
-- "by <name>" in the status history. Imported events keep changed_by = null.
alter table public.project_status_events
  add constraint project_status_events_changed_by_fkey
  foreign key (changed_by) references public.staff(user_id) on delete set null;
create index on public.project_status_events (changed_by);
