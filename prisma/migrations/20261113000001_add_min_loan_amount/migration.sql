-- Add minimum loan amount to credit config (replaces the old tier-based system)
ALTER TABLE "credit_config" ADD COLUMN IF NOT EXISTS "min_loan_amount" INTEGER NOT NULL DEFAULT 5000;

-- Reset contributing months default to 1 (tiers no longer enforce per-tier minimums)
UPDATE "credit_config" SET "min_contributing_months" = 1 WHERE "min_contributing_months" > 1;
