import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import { ApiBody, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";

import { CreateInstantSwapDto } from "./dto/create-instant-swap.dto.js";
import { CreateSwapDto } from "./dto/create-swap.dto.js";
import type {
  SwapJobSummaryResponse,
  SwapTrancheListResponse,
} from "./interfaces/swap-response.js";
import { SwapOrchestrationService } from "./services/swap-orchestration.service.js";
import { SwapProgressService } from "./services/swap-progress.service.js";

@ApiTags("swap")
@Controller()
export class SwapController {
  constructor(
    private readonly swapOrchestrationService: SwapOrchestrationService,
    private readonly swapProgressService: SwapProgressService,
  ) {}

  @ApiOperation({ summary: "Create a scheduled swap job" })
  @ApiBody({ type: CreateSwapDto })
  @Post("swap")
  createSwap(@Body() dto: CreateSwapDto): Promise<SwapJobSummaryResponse> {
    return this.swapOrchestrationService.createSwap(dto);
  }

  @ApiOperation({
    summary: "Execute an instant swap from a pre-fetched Fly quote",
  })
  @ApiBody({ type: CreateInstantSwapDto })
  @Post("swap/instant")
  createInstantSwap(
    @Body() dto: CreateInstantSwapDto,
  ): Promise<SwapJobSummaryResponse> {
    return this.swapOrchestrationService.createInstantSwap(dto);
  }

  @ApiOperation({ summary: "Get swap job status" })
  @ApiParam({ name: "id", format: "uuid" })
  @Get("swap/:id")
  getSwap(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
  ): Promise<SwapJobSummaryResponse> {
    return this.swapProgressService.getSwapSummary(id);
  }

  @ApiOperation({ summary: "List tranches for a swap job" })
  @ApiParam({ name: "id", format: "uuid" })
  @Get("swap/:id/tranches")
  getSwapTranches(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
  ): Promise<SwapTrancheListResponse> {
    return this.swapProgressService.getSwapTranches(id);
  }
}
