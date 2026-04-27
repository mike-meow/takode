#!/usr/bin/env bun
/**
 * One-off operator-run migration for this machine's persisted prod server state.
 *
 * Dry-run / preflight:
 *   bun run scripts/migrate-prod-port-3455-to-3456.ts
 *
 * Apply after stopping the live 3455 server:
 *   PORT_MIGRATION_APPLY=1 bun run scripts/migrate-prod-port-3455-to-3456.ts
 *
 * Optional verification override:
 *   COMPANION_HOME=/tmp/fixture bun run scripts/migrate-prod-port-3455-to-3456.ts
 */

import {
  runOneOffProdPort3455To3456Migration,
  type OneOffProdPortMigrationPlan,
} from "../web/server/one-off-prod-port-3455-to-3456.ts";

const apply = process.env.PORT_MIGRATION_APPLY === "1";
const companionHome = process.env.COMPANION_HOME;
const backupRoot = process.env.PORT_MIGRATION_BACKUP_ROOT;

function printPlan(plan: OneOffProdPortMigrationPlan): void {
  console.log(`Companion home: ${plan.companionHome}`);
  console.log(`Source: port ${plan.sourcePort} (serverId ${plan.sourceServerId})`);
  console.log(`Target: port ${plan.targetPort}${plan.targetServerId ? ` (serverId ${plan.targetServerId})` : ""}`);
  console.log(`Backup dir: ${plan.backupDir}`);
  console.log(`Source sessions: ${plan.sourceSessionsDir} (${plan.sourceSessionsFileCount} files)`);
  console.log(`Target sessions: ${plan.targetSessionsDir} (${plan.targetSessionsFileCount} files)`);
  console.log(`Source tree groups: ${plan.sourceTreeGroupsPath}`);
  console.log(`Source session-auth files: ${plan.sourceSessionAuthPaths.length}`);
  console.log(`Target session-auth files: ${plan.targetSessionAuthPaths.length}`);
  if (plan.willPatchPushoverBaseUrl) {
    console.log(`Pushover base URL patch: ${plan.pushoverBaseUrlBefore} -> ${plan.pushoverBaseUrlAfter}`);
  }
  if (plan.notes.length > 0) {
    console.log("\nNotes:");
    for (const note of plan.notes) {
      console.log(`- ${note}`);
    }
  }
}

function printValidationChecklist(): void {
  console.log("\nPost-cutover validation:");
  console.log("1. Confirm 3455 is down and 3456 is listening.");
  console.log("2. Open /api/settings and confirm the reused 3455 serverId is now serving on 3456.");
  console.log(
    "3. Confirm the expected tree groups are still present on 3456 instead of falling back to an empty/default-only view.",
  );
  console.log(
    "4. From a representative existing worktree, run `quest status q-922` without setting COMPANION_PORT and confirm it succeeds against 3456.",
  );
  console.log("5. If any check fails, stop 3456 and run the generated rollback script.");
}

try {
  const result = await runOneOffProdPort3455To3456Migration({
    companionHome,
    backupRoot,
    apply,
  });

  console.log(apply ? "Migration applied." : "Dry-run only. No files were changed.");
  printPlan(result.plan);

  if (!result.applied) {
    console.log("\nNext steps:");
    console.log("1. Stop the live server on port 3455.");
    console.log("2. Re-run with PORT_MIGRATION_APPLY=1.");
    console.log("3. Restart prod on 3456 with: cd web && PORT=3456 bun run start");
    printValidationChecklist();
    process.exit(0);
  }

  console.log(`\nRewritten session-auth files: ${result.rewrittenSessionAuthCount}`);
  console.log(`Manifest: ${result.manifestPath}`);
  console.log(`Rollback script: ${result.rollbackScriptPath}`);
  console.log("\nOperator next steps:");
  console.log("1. Restart prod on 3456 with: cd web && PORT=3456 bun run start");
  printValidationChecklist();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Migration failed: ${message}`);
  process.exit(1);
}
