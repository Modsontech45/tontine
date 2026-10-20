-- Add due_date to loan_requests
ALTER TABLE "loan_requests" ADD COLUMN "due_date" TIMESTAMPTZ;

-- Add REPAID to LoanStatus enum
ALTER TYPE "LoanStatus" ADD VALUE IF NOT EXISTS 'REPAID';

-- Create loan_repayments table
CREATE TABLE "loan_repayments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "loan_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "cashier_id" UUID NOT NULL,
    "note" TEXT,
    "paid_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "loan_repayments_pkey" PRIMARY KEY ("id")
);

-- Index for fast lookup by loan
CREATE INDEX "loan_repayments_loan_id_idx" ON "loan_repayments"("loan_id");

-- Foreign keys
ALTER TABLE "loan_repayments" ADD CONSTRAINT "loan_repayments_loan_id_fkey"
    FOREIGN KEY ("loan_id") REFERENCES "loan_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "loan_repayments" ADD CONSTRAINT "loan_repayments_cashier_id_fkey"
    FOREIGN KEY ("cashier_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
