import { Module } from "@nestjs/common";

import { CustodyModule } from "../custody/custody.module.js";
import { SolanaModule } from "../solana/solana.module.js";
import { WalletController } from "./wallet.controller.js";
import { WalletService } from "./wallet.service.js";

@Module({
  imports: [SolanaModule, CustodyModule],
  controllers: [WalletController],
  providers: [WalletService],
})
export class WalletModule {}
