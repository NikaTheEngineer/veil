import { Module } from "@nestjs/common";

import { SolanaModule } from "../solana/solana.module.js";
import { CustodyProviderRegistry } from "../wallet/providers/custody-provider.registry.js";
import { MagicBlockCustodyStrategy } from "../wallet/providers/magicblock-custody.strategy.js";
import { MagicBlockTeeAuthService } from "../wallet/providers/magicblock-tee-auth.service.js";

@Module({
  imports: [SolanaModule],
  providers: [
    MagicBlockTeeAuthService,
    MagicBlockCustodyStrategy,
    CustodyProviderRegistry,
  ],
  exports: [CustodyProviderRegistry],
})
export class CustodyModule {}
