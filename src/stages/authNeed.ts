import type { TestCase } from "../stages/testCases.ts";

export interface AuthNeed {
  authType: "login" | "signup";
  requiredFields: string[];
  reason: string;
}

export function classifyAuthNeed(cases: TestCase[]): AuthNeed | null {
  const loginCase = cases.find(tc =>
    /(login|log in|sign in|authentication)/i.test(tc.title) ||
    tc.steps.some(s =>
      /(email address|username|password|sign in|log in)/i.test(s)
    )
  );

  if (loginCase) {
    return {
      authType: "login",
      requiredFields: ["username_or_email", "password"],
      reason: "Please provide valid login credentials for this application."
    };
  }

  const signupCase = cases.find(tc =>
    /(sign up|signup|register|registration)/i.test(tc.title)
  );

  if (signupCase) {
    return {
      authType: "signup",
      requiredFields: ["username_or_email", "password", "confirmPassword"],
      reason: "Please provide registration details so the account can be created during the test."
    };
  }

  return null;
}