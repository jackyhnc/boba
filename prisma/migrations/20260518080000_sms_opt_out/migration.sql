-- Carrier-required SMS opt-out flag.
ALTER TABLE "User"
    ADD COLUMN "smsOptedOut" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "smsOptedOutAt" TIMESTAMP(3);

CREATE INDEX "User_smsOptedOut_idx" ON "User"("smsOptedOut");
