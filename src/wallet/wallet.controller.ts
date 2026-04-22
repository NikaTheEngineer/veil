import { Body, Controller, Post } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";

import { BalanceDto } from "./dto/balance.dto.js";
import { DepositDto } from "./dto/deposit.dto.js";
import { WithdrawDto } from "./dto/withdraw.dto.js";
import type {
  WalletBalanceResponse,
  WalletTransactionResponse,
} from "./interfaces/wallet-response.js";
import { WalletService } from "./wallet.service.js";

@ApiTags("wallet")
@Controller()
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @ApiOperation({ summary: "Deposit tokens into custody" })
  @ApiBody({ type: DepositDto })
  @Post("deposit")
  deposit(@Body() dto: DepositDto): Promise<WalletTransactionResponse> {
    return this.walletService.deposit(dto);
  }

  @ApiOperation({ summary: "Withdraw tokens from custody" })
  @ApiBody({ type: WithdrawDto })
  @Post("withdraw")
  withdraw(@Body() dto: WithdrawDto): Promise<WalletTransactionResponse> {
    return this.walletService.withdraw(dto);
  }

  @ApiOperation({ summary: "Read private custody balance" })
  @ApiBody({ type: BalanceDto })
  @Post("balance")
  balance(@Body() dto: BalanceDto): Promise<WalletBalanceResponse> {
    return this.walletService.balance(dto);
  }
}
