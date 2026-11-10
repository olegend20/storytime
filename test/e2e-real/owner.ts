/**
 * Issue #92: the owner of the real-stack e2e server, so a test can approve the waitlist at
 * /admin/waitlist. playwright.real.config.ts starts the app with OWNER_USER_ID set to this
 * id; waitlist.spec.ts creates the user with it. Never a real person.
 */
export const E2E_OWNER_ID = '0e2e0092-0000-4000-8000-000000000092'
export const E2E_OWNER_EMAIL = 'lane1-e2e-waitlist-owner@storytime.test'
