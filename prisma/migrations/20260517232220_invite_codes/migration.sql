-- Invite codes (closed-beta gate).
CREATE TABLE "InviteCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redeemedAt" TIMESTAMP(3),
    "redeemedById" TEXT,
    CONSTRAINT "InviteCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InviteCode_code_key" ON "InviteCode"("code");
CREATE UNIQUE INDEX "InviteCode_redeemedById_key" ON "InviteCode"("redeemedById");
CREATE INDEX "InviteCode_redeemedAt_idx" ON "InviteCode"("redeemedAt");

ALTER TABLE "InviteCode"
    ADD CONSTRAINT "InviteCode_redeemedById_fkey"
    FOREIGN KEY ("redeemedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
