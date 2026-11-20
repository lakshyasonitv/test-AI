
export interface Member { userId: string; email?: string | null; role: string }

export const ADMIN_ROLES = ["owner", "tester", "viewer"];
