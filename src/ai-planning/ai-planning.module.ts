import { Module } from "@nestjs/common";

import { AnthropicPlanningService } from "./anthropic-planning.service.js";
import { TranchePlanValidationService } from "./tranche-plan-validation.service.js";

@Module({
  providers: [AnthropicPlanningService, TranchePlanValidationService],
  exports: [AnthropicPlanningService, TranchePlanValidationService],
})
export class AiPlanningModule {}
