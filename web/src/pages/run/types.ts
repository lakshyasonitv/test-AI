
export interface SuiteSummary {
  total: number; passed: number; failed: number; truncated?: number; truncated_no_assertion?: number; blocked?: number;
  cases: any[];
}

export interface Details { ir: any; irText: string; spec: string; diagnosis: any; results: any; raw: any; strict: boolean }
