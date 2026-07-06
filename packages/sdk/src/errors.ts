/**
 * Error names byte-identical with the Python SDK. `BudgetExceeded` (tokenguard) and `PolicyViolation`
 * (acttrace) are the real library error classes, re-exported so callers catch by the same name.
 */
export { BudgetExceeded } from '@cendor/tokenguard';
export { PolicyViolation } from '@cendor/acttrace';
