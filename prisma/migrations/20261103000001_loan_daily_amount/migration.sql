-- Add daily_amount to loan_requests
ALTER TABLE "loan_requests"
  ADD COLUMN "daily_amount" INTEGER NOT NULL DEFAULT 0;

-- Backfill: daily_amount = ceil(total_repay / (duration_months * 31))
UPDATE "loan_requests"
SET "daily_amount" = CEIL("total_repay"::numeric / ("duration_months" * 31));
