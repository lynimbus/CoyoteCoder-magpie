import type { CoyoteEvent } from "../events/types.ts";
import type { SafetyStatus } from "./safety.ts";
import type { ShockPlan } from "./types.ts";

export type ShockPlanOutcome = "sent" | "blocked" | "error";

export interface ShockPlanRecord {
  id: number;
  timestamp: number;
  eventType: CoyoteEvent["type"];
  requestId?: string;
  model?: string;
  input: ShockPlan;
  output?: ShockPlan;
  outcome: ShockPlanOutcome;
  error?: string;
  safety: SafetyStatus;
}

export class ShockPlanStore {
  private readonly records: ShockPlanRecord[] = [];
  private nextId = 1;

  constructor(private readonly limit: number) {}

  add(record: Omit<ShockPlanRecord, "id">): ShockPlanRecord {
    const stored = {
      ...record,
      id: this.nextId++
    };
    this.records.push(stored);
    if (this.records.length > this.limit) {
      this.records.splice(0, this.records.length - this.limit);
    }
    return stored;
  }

  getRecent(count = this.limit): ShockPlanRecord[] {
    return this.records.slice(-Math.max(0, count));
  }
}
