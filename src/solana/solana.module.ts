import { Module } from "@nestjs/common";

import { SolanaService } from "../wallet/solana.service.js";

@Module({
  providers: [SolanaService],
  exports: [SolanaService],
})
export class SolanaModule {}
