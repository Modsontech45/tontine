-- Add interest_amount and disbursed_amount to loan_requests
ALTER TABLE "loan_requests"
  ADD COLUMN "interest_amount"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "disbursed_amount" INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows: interest_amount = total_repay - amount, disbursed_amount = amount - interest_amount
UPDATE "loan_requests"
SET
  "interest_amount"  = "total_repay" - "amount",
  "disbursed_amount" = "amount" - ("total_repay" - "amount");

-- Re-set total_repay = amount (client repays only the principal; interest was already taken upfront)
-- Only update PENDING/APPROVED loans; leave historical ones untouched to avoid confusion
UPDATE "loan_requests"
SET "total_repay" = "amount"
WHERE "status" IN ('PENDING', 'APPROVED');
