-- 002_ticket_fare_type.sql
-- Adds a fare type (adult/child) to tickets, for payment reconciliation only.
-- Not enforced with a CHECK constraint - the allow-list lives in application
-- code (src/routes/tickets.js) so adding a third fare type later is a one-line
-- change, not a migration.

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS fare_type TEXT NOT NULL DEFAULT 'adult';
