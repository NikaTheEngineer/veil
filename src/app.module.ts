import { Module } from "@nestjs/common";

import { PrismaModule } from "./prisma/prisma.module.js";
import { SwapModule } from "./swap/swap.module.js";
import { WalletModule } from "./wallet/wallet.module.js";

@Module({
  imports: [PrismaModule, WalletModule, SwapModule],
})
export class AppModule {}
