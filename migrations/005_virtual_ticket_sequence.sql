-- 005_virtual_ticket_sequence.sql
-- Backs the "Issue Virtual Ticket" action on R2 (Central -> Hub boarding) -
-- a rider with no ticket at all (not even a lost one to scan) can be issued
-- a brand-new standby ticket on the spot, without anyone having to type or
-- scan a code. Codes are generated from this sequence rather than picked by
-- a volunteer, so they're guaranteed unique and start at 9000 - a clearly
-- out-of-band range that can't collide with real event ticket codes.
CREATE SEQUENCE IF NOT EXISTS virtual_ticket_code_seq START WITH 9000;
