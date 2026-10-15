-- One OPEN cycle per client (enforced at DB level)
CREATE UNIQUE INDEX IF NOT EXISTS "one_open_cycle" ON "cycles"("client_id") WHERE "status" = 'OPEN';

-- Voided collections excluded from cycle queries
CREATE INDEX IF NOT EXISTS "collections_cycle_active" ON "collections"("cycle_id") WHERE "voided_at" IS NULL;
