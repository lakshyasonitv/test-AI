import { type Conflict, type Estimate, type Job, type Line, type Proposal } from "./lib";

export interface Editor {
  lines: Line[]; original: string; currentVersion: number; expected: string; nlSteps: boolean;
  estimate: Estimate | null; estimateError: string;
  job: Job | null; errorAt: number | null; errorMsg: string; errorKind: "" | "reach" | "ground";
  conflict: Conflict | null; askText: string; proposal: Proposal | null; notice: string;
  justSaved: boolean; needsConfirmation: string;
  saving: boolean; asking: boolean; translating: boolean;
}
