/**
 * Centralized configuration for the AI Test Platform
 */
export const CONFIG = {
  // Timeouts (in milliseconds)
  TIMEOUTS: {
    PAGE_LOAD: 15_000,
    ELEMENT_WAIT: 10_000,
    TEST_RUN: 60_000,
    ANIMATION: 500,
    RETRY_DELAY: 2_000,
    PLAYWRIGHT_DEFAULT: 30_000,
  },

  // Retry settings
  RETRIES: {
    MAX_ATTEMPTS: 2,
    DELAY_BETWEEN: 2_000,
  },

  // Selector fixes for known duplicate elements
  SELECTOR_FIXES: {
    // Elements that commonly appear multiple times
    duplicateLinks: {
      'Student': { nth: 1 },  // Use second occurrence (0-indexed)
      'IQAC': { nth: 0 },     // Use first occurrence
    },
    
    // Links to skip (non-functional or problematic)
    skipLinks: ['About SKIT', 'javascript:void(0)', '#'],
    
    // URL patterns that need partial matching
    skipUrlPatterns: ['/about'],
    
    // Dropdown parent items that need hover preAction
    dropdownParents: ['Academics', 'Admissions', 'Research', 'Placements'],
  },

  // Playwright settings
  PLAYWRIGHT: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    timeout: 60_000,
    retries: 2,
    screenshot: 'on',
    trace: 'on-first-retry',
  },

  // LLM settings
  LLM: {
    maxRetries: 3,
    timeout: 30_000,
    model: 'llama3-8b-8192',
  },

  // Debug settings
  DEBUG: {
    enabled: process.env.DEBUG === 'true',
    logLevel: process.env.LOG_LEVEL || 'info',
  },
} as const;

export type Config = typeof CONFIG;