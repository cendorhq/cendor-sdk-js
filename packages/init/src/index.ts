/**
 * `@cendor/init` — programmatic API behind the `cendor-init` CLI (`init` + `doctor`).
 *
 * Offline scaffolding + wiring validation for Cendor projects. The CLI (`dist/cli.js`) is the usual
 * entry point (`npx @cendor/init`); these exports let you drive the same logic from code or tests.
 */
export { runInit, mcpGuidance, type InitOptions, type InitResult } from './init.js';
export { runDoctor, type DoctorResult } from './doctor.js';
export { detectProject, type Detected } from './detect.js';
export {
  ALL_ASSISTANTS,
  type Assistant,
  type Ecosystem,
  type FileAction,
  type FileStatus,
  type Finding,
  type Severity,
} from './types.js';
