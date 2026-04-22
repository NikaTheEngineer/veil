import { Module } from "@nestjs/common";

import { AiPlanningModule } from "../ai-planning/ai-planning.module.js";
import { CustodyModule } from "../custody/custody.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { SolanaModule } from "../solana/solana.module.js";
import { FlySwapStrategy } from "../wallet/providers/fly-swap.strategy.js";
import { SwapProviderRegistry } from "../wallet/providers/swap-provider.registry.js";
import { SwapExecutionService } from "./services/swap-execution.service.js";
import { SwapOrchestrationService } from "./services/swap-orchestration.service.js";
import { SwapPlanningPolicyService } from "./services/swap-planning-policy.service.js";
import { SwapProgressService } from "./services/swap-progress.service.js";
import { SwapSchedulerService } from "./services/swap-scheduler.service.js";
import { TempWalletCryptoService } from "./services/temp-wallet-crypto.service.js";
import { SwapController } from "./swap.controller.js";

@Module({
  imports: [AiPlanningModule, CustodyModule, PrismaModule, SolanaModule],
  controllers: [SwapController],
  providers: [
    FlySwapStrategy,
    SwapProviderRegistry,
    SwapPlanningPolicyService,
    TempWalletCryptoService,
    SwapProgressService,
    SwapExecutionService,
    SwapSchedulerService,
    SwapOrchestrationService,
  ],
  exports: [SwapProviderRegistry],
})
export class SwapModule {}
