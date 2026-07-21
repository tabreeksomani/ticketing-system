-- 007_hub_opened.sql
-- Mirrors closed_at (006) - a volunteer explicitly marks their hub "opened"
-- at the start of the day, recorded so admin can see both opened/closed
-- times per hub. Purely a record for now, same as closed_at was before it
-- gated trip creation - not itself a gate on anything yet.
ALTER TABLE hubs ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;
