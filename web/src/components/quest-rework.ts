export function buildQuestReworkDraft(questId: string): string {
  return `Work on [${questId}](quest:${questId}). Read the quest and check unaddressed feedback: \`quest show ${questId} && quest claim ${questId}\`.
Address all unaddressed feedback items. After fixing each item, mark it as addressed: \`quest address ${questId} <index>\`.
Return a plan for approval before implementing. After you send the plan, stop and wait for approval.`;
}
