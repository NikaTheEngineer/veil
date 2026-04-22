import { BadRequestException, Injectable } from "@nestjs/common";

import type { SwapProvider } from "../../common/enums/swap-provider.enum.js";
import type { SwapProviderStrategy } from "../interfaces/swap-provider.strategy.js";
import { FlySwapStrategy } from "./fly-swap.strategy.js";

@Injectable()
export class SwapProviderRegistry {
  private readonly strategiesByProvider: Map<
    SwapProvider,
    SwapProviderStrategy
  >;

  constructor(flyStrategy: FlySwapStrategy) {
    const strategies: SwapProviderStrategy[] = [flyStrategy];
    this.strategiesByProvider = new Map(
      strategies.map((strategy) => [strategy.provider, strategy]),
    );
  }

  get(provider: SwapProvider): SwapProviderStrategy {
    const strategy = this.strategiesByProvider.get(provider);

    if (!strategy) {
      throw new BadRequestException(`Unsupported swap provider: ${provider}`);
    }

    return strategy;
  }
}
