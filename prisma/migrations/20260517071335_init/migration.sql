-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ONBOARDING', 'ACTIVE', 'PAUSED', 'BANNED');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('WOMAN', 'MAN', 'NONBINARY', 'OTHER');

-- CreateEnum
CREATE TYPE "MatchState" AS ENUM ('ACTIVE', 'AWAITING_DECISION', 'CONTINUED', 'ENDED_BY_DISCARD', 'EXPIRED');

-- CreateEnum
CREATE TYPE "MilestoneType" AS ENUM ('AGE', 'PROFESSION', 'HEIGHT', 'FACE');

-- CreateEnum
CREATE TYPE "Decision" AS ENUM ('KEEP', 'MAYBE', 'DISCARD');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "displayName" TEXT,
    "campusEmailDomain" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ONBOARDING',
    "isAiBacked" BOOLEAN NOT NULL DEFAULT false,
    "aiPersonaPrompt" TEXT,
    "reportCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "minAge" INTEGER,
    "maxAge" INTEGER,
    "preferredGenders" "Gender"[] DEFAULT ARRAY[]::"Gender"[],
    "minHeightCm" INTEGER,
    "maxHeightCm" INTEGER,
    "preferredProfessions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "typeDescriptor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stats" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "age" INTEGER,
    "gender" "Gender",
    "profession" TEXT,
    "heightCm" INTEGER,
    "photoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyMatch" (
    "id" TEXT NOT NULL,
    "userAId" TEXT NOT NULL,
    "userBId" TEXT NOT NULL,
    "matchDate" DATE NOT NULL,
    "state" "MatchState" NOT NULL DEFAULT 'ACTIVE',
    "compatibilityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "parentMatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "body" TEXT NOT NULL,
    "twilioSid" TEXT,
    "depthScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "flaggedStatFishing" BOOLEAN NOT NULL DEFAULT false,
    "flaggedHarassment" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MilestoneProgress" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "milestone" "MilestoneType" NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MilestoneProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EndOfDayDecision" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "decision" "Decision" NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EndOfDayDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RematchHistory" (
    "id" TEXT NOT NULL,
    "userAId" TEXT NOT NULL,
    "userBId" TEXT NOT NULL,
    "firstMatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "matchCount" INTEGER NOT NULL DEFAULT 1,
    "hasDiscard" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RematchHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Preferences_userId_key" ON "Preferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Stats_userId_key" ON "Stats"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyMatch_parentMatchId_key" ON "DailyMatch"("parentMatchId");

-- CreateIndex
CREATE INDEX "DailyMatch_matchDate_idx" ON "DailyMatch"("matchDate");

-- CreateIndex
CREATE INDEX "DailyMatch_state_idx" ON "DailyMatch"("state");

-- CreateIndex
CREATE UNIQUE INDEX "DailyMatch_userAId_userBId_matchDate_key" ON "DailyMatch"("userAId", "userBId", "matchDate");

-- CreateIndex
CREATE UNIQUE INDEX "Message_twilioSid_key" ON "Message"("twilioSid");

-- CreateIndex
CREATE INDEX "Message_matchId_createdAt_idx" ON "Message"("matchId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_senderId_idx" ON "Message"("senderId");

-- CreateIndex
CREATE INDEX "MilestoneProgress_matchId_idx" ON "MilestoneProgress"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "MilestoneProgress_matchId_milestone_key" ON "MilestoneProgress"("matchId", "milestone");

-- CreateIndex
CREATE INDEX "EndOfDayDecision_matchId_idx" ON "EndOfDayDecision"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "EndOfDayDecision_matchId_userId_key" ON "EndOfDayDecision"("matchId", "userId");

-- CreateIndex
CREATE INDEX "RematchHistory_lastMatchedAt_idx" ON "RematchHistory"("lastMatchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RematchHistory_userAId_userBId_key" ON "RematchHistory"("userAId", "userBId");

-- CreateIndex
CREATE INDEX "Report_subjectId_idx" ON "Report"("subjectId");

-- CreateIndex
CREATE INDEX "Report_reporterId_idx" ON "Report"("reporterId");

-- AddForeignKey
ALTER TABLE "Preferences" ADD CONSTRAINT "Preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stats" ADD CONSTRAINT "Stats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyMatch" ADD CONSTRAINT "DailyMatch_userAId_fkey" FOREIGN KEY ("userAId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyMatch" ADD CONSTRAINT "DailyMatch_userBId_fkey" FOREIGN KEY ("userBId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyMatch" ADD CONSTRAINT "DailyMatch_parentMatchId_fkey" FOREIGN KEY ("parentMatchId") REFERENCES "DailyMatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "DailyMatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneProgress" ADD CONSTRAINT "MilestoneProgress_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "DailyMatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EndOfDayDecision" ADD CONSTRAINT "EndOfDayDecision_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "DailyMatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EndOfDayDecision" ADD CONSTRAINT "EndOfDayDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

