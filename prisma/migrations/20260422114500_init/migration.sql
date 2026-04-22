-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CustodyProvider" AS ENUM ('MAGICBLOCK');

-- CreateEnum
CREATE TYPE "SwapProvider" AS ENUM ('FLY');

-- CreateEnum
CREATE TYPE "SwapExecutionMode" AS ENUM ('INSTANT', 'FAST', 'SECURE');

-- CreateEnum
CREATE TYPE "SwapStatus" AS ENUM ('PLANNING', 'PLANNED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "SwapTrancheStatus" AS ENUM ('ADDRESS_GENERATED', 'FUNDING_SUBMITTED', 'FUNDED', 'QUOTE_RECEIVED', 'SWAP_SUBMITTED', 'SWAPPED', 'DEPOSIT_SUBMITTED', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "SwapJob" (
    "id" TEXT NOT NULL,
    "custodyProvider" "CustodyProvider" NOT NULL,
    "swapProvider" "SwapProvider" NOT NULL,
    "executionMode" "SwapExecutionMode" NOT NULL,
    "fromMint" TEXT NOT NULL,
    "toMint" TEXT NOT NULL,
    "fromAmount" TEXT NOT NULL,
    "targetToAmount" TEXT NOT NULL,
    "slippage" TEXT NOT NULL,
    "status" "SwapStatus" NOT NULL,
    "plannerModel" TEXT NOT NULL,
    "plannerPromptVersion" TEXT NOT NULL,
    "planningCurrentUtc" TIMESTAMP(3) NOT NULL,
    "plannedFromAmount" TEXT NOT NULL,
    "swappedFromAmount" TEXT NOT NULL,
    "remainingFromAmount" TEXT NOT NULL,
    "sourceDepositSignature" TEXT,
    "totalTranches" INTEGER NOT NULL,
    "readyTranches" INTEGER NOT NULL,
    "fundedTranches" INTEGER NOT NULL,
    "submittedSwapTranches" INTEGER NOT NULL,
    "depositedTranches" INTEGER NOT NULL,
    "failedTranches" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SwapJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SwapTranche" (
    "id" TEXT NOT NULL,
    "swapJobId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "plannedAmount" TEXT NOT NULL,
    "executeAtUtc" TIMESTAMP(3) NOT NULL,
    "tempWalletPublicKey" TEXT NOT NULL,
    "encryptedTempWalletSecret" TEXT NOT NULL,
    "tempWalletEncryptionIv" TEXT NOT NULL,
    "tempWalletEncryptionAuthTag" TEXT NOT NULL,
    "tempWalletEncryptionAlgorithm" TEXT NOT NULL,
    "status" "SwapTrancheStatus" NOT NULL,
    "statusReason" TEXT,
    "withdrawSignature" TEXT,
    "fundingSignature" TEXT,
    "swapSignature" TEXT,
    "depositSignature" TEXT,
    "quoteId" TEXT,
    "quoteTool" TEXT,
    "lastError" TEXT,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SwapTranche_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SwapPlannerRun" (
    "id" TEXT NOT NULL,
    "swapJobId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "rawRequestJson" JSONB NOT NULL,
    "rawResponseJson" JSONB,
    "validationSucceeded" BOOLEAN NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SwapPlannerRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SwapJob_status_idx" ON "SwapJob"("status");

-- CreateIndex
CREATE INDEX "SwapTranche_swapJobId_executeAtUtc_idx" ON "SwapTranche"("swapJobId", "executeAtUtc");

-- CreateIndex
CREATE INDEX "SwapTranche_status_executeAtUtc_idx" ON "SwapTranche"("status", "executeAtUtc");

-- CreateIndex
CREATE UNIQUE INDEX "SwapTranche_swapJobId_sequence_key" ON "SwapTranche"("swapJobId", "sequence");

-- CreateIndex
CREATE INDEX "SwapPlannerRun_swapJobId_createdAt_idx" ON "SwapPlannerRun"("swapJobId", "createdAt");

-- AddForeignKey
ALTER TABLE "SwapTranche" ADD CONSTRAINT "SwapTranche_swapJobId_fkey" FOREIGN KEY ("swapJobId") REFERENCES "SwapJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SwapPlannerRun" ADD CONSTRAINT "SwapPlannerRun_swapJobId_fkey" FOREIGN KEY ("swapJobId") REFERENCES "SwapJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

