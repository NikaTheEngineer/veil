import { IsEnum } from "class-validator";

import { CustodyProvider } from "../../common/enums/custody-provider.enum.js";
import { SwapProvider } from "../../common/enums/swap-provider.enum.js";

export class SwapDto {
  @IsEnum(CustodyProvider)
  custodyProvider!: CustodyProvider;

  @IsEnum(SwapProvider)
  swapProvider!: SwapProvider;
}
