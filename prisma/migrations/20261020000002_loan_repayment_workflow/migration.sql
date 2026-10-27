-- Add LoanRepaymentStatus enum
CREATE TYPE "LoanRepaymentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- Alter loan_repayments table
ALTER TABLE "loan_repayments"
  ADD COLUMN "status"        "LoanRepaymentStatus" NOT NULL DEFAULT 'CONFIRMED',
  ADD COLUMN "collector_id"  UUID,
  ADD COLUMN "confirmed_at"  TIMESTAMPTZ;

-- Rename paid_at → recorded_at
ALTER TABLE "loan_repayments" RENAME COLUMN "paid_at" TO "recorded_at";

-- Make cashier_id nullable (it was NOT NULL before)
ALTER TABLE "loan_repayments" ALTER COLUMN "cashier_id" DROP NOT NULL;

-- Foreign key for collector
ALTER TABLE "loan_repayments" ADD CONSTRAINT "loan_repayments_collector_id_fkey"
  FOREIGN KEY ("collector_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Index for pending repayments lookup
CREATE INDEX "loan_repayments_status_idx" ON "loan_repayments"("status");
