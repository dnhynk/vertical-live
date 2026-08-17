/**
 * Browser-safe scenario layer: schema, envelope assembly and the built-in
 * catalog. It depends on `@vl/contract` and nothing else, so the renderer's
 * `?mode=dev` panel and the Node CLI build the *same* envelopes from the *same*
 * definitions (TASK_SPECS §T11).
 */
export {
  CONTROL_NAMES,
  ChatStepSchema,
  CommandStepSchema,
  ControlStepSchema,
  GiftStepSchema,
  InvalidStepSchema,
  MembershipStepSchema,
  SYNTHETIC_ID_PATTERN,
  ScenarioError,
  ScenarioSchema,
  ScenarioStepSchema,
  SuperChatStepSchema,
  SuperStickerStepSchema,
  UnsupportedStepSchema,
  WaitStepSchema,
  parseScenario,
  type ControlName,
  type Scenario,
  type ScenarioInput,
  type ScenarioStep,
  type ScenarioStepInput,
} from './schema.js'
export {
  planScenario,
  requiresParser,
  scenarioIdentity,
  type PlanOptions,
  type ScenarioBatch,
  type ScenarioIdentity,
  type ScenarioPlan,
} from './build.js'
export { BUILTIN_SCENARIOS, findBuiltinScenario } from './catalog.js'
