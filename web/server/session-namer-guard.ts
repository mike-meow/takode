export type AutoNamerSkipReason = "disabled" | "no_auto_name" | "user_named" | "quest_owned";

export interface AutoNamerGuardChecks {
  isAutoNamerEnabled: () => boolean;
  isNoAutoNameSession: () => boolean;
  isUserNamed: () => boolean;
  isQuestOwningName: () => Promise<boolean>;
}

export async function getAutoNamerSkipReason(checks: AutoNamerGuardChecks): Promise<AutoNamerSkipReason | null> {
  if (!checks.isAutoNamerEnabled()) return "disabled";
  if (checks.isNoAutoNameSession()) return "no_auto_name";
  if (checks.isUserNamed()) return "user_named";
  if (await checks.isQuestOwningName()) return "quest_owned";
  return null;
}

export function formatAutoNamerSkipReason(reason: AutoNamerSkipReason): string {
  switch (reason) {
    case "disabled":
      return "auto-namer disabled";
    case "no_auto_name":
      return "session is marked noAutoName";
    case "user_named":
      return "manually renamed by user";
    case "quest_owned":
      return "quest owns session name";
  }
}
