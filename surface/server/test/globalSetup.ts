import { dropTestDatabasesForRun } from './helpers.js';

export default async function setup(): Promise<() => Promise<void>> {
  // In the current Vitest fork pool, every worker in one run has this process
  // as process.ppid. Using the main Vitest pid gives concurrent runs distinct
  // database suffixes and gives stale cleanup a host-local liveness check.
  const runId = String(process.pid);
  process.env.ATRIUM_TEST_RUN_ID = runId;

  return async () => {
    await dropTestDatabasesForRun(runId).catch(() => {});
  };
}
