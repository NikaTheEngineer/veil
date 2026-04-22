import { BadRequestException, Injectable } from "@nestjs/common";

import type { CustodyProvider } from "../../common/enums/custody-provider.enum.js";
import type { CustodyProviderStrategy } from "../interfaces/custody-provider.strategy.js";
import { MagicBlockCustodyStrategy } from "./magicblock-custody.strategy.js";

@Injectable()
export class CustodyProviderRegistry {
  private readonly strategiesByProvider: Map<
    CustodyProvider,
    CustodyProviderStrategy
  >;

  constructor(magicBlockStrategy: MagicBlockCustodyStrategy) {
    const strategies: CustodyProviderStrategy[] = [magicBlockStrategy];
    this.strategiesByProvider = new Map(
      strategies.map((strategy) => [strategy.provider, strategy]),
    );
  }

  get(provider: CustodyProvider): CustodyProviderStrategy {
    const strategy = this.strategiesByProvider.get(provider);

    if (!strategy) {
      throw new BadRequestException(
        `Unsupported custody provider: ${provider}`,
      );
    }

    return strategy;
  }
}
