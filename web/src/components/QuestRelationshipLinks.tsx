import type { QuestRelatedQuest, QuestRelatedQuestKind, QuestmasterTask } from "../types.js";
import { QuestInlineLink } from "./QuestInlineLink.js";

type DisplayedQuestRelationshipKind = Exclude<QuestRelatedQuestKind, "references">;

const RELATIONSHIP_LABELS: Record<DisplayedQuestRelationshipKind, string> = {
  follow_up_of: "Follow-up of",
  has_follow_up: "Has follow-up",
  referenced_by: "Referenced by",
};

const RELATIONSHIP_ORDER: DisplayedQuestRelationshipKind[] = ["follow_up_of", "has_follow_up", "referenced_by"];

export function QuestRelationshipLinks({
  quest,
  variant = "detail",
}: {
  quest: QuestmasterTask;
  variant?: "detail" | "inline";
}) {
  const groups = groupRelatedQuests(quest.relatedQuests ?? []);
  if (groups.length === 0) return null;

  if (variant === "inline") {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-cc-muted">
        {groups.map(([kind, entries]) => (
          <span key={kind} className="inline-flex min-w-0 items-center gap-1">
            <span className="text-cc-muted/70">{RELATIONSHIP_LABELS[kind]}</span>
            {entries.map((entry) => (
              <QuestInlineLink
                key={`${kind}:${entry.questId}`}
                questId={entry.questId}
                className="font-mono-code text-cc-primary hover:underline"
                stopPropagation
              />
            ))}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-1.5" data-testid="quest-relationships">
      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-cc-muted/60">Related Quests</div>
      <div className="flex flex-wrap gap-1.5">
        {groups.flatMap(([kind, entries]) =>
          entries.map((entry) => (
            <span
              key={`${kind}:${entry.questId}`}
              className="inline-flex items-center gap-1 rounded-full border border-cc-border bg-cc-hover/60 px-2 py-0.5 text-[11px] text-cc-muted"
            >
              <span>{RELATIONSHIP_LABELS[kind]}</span>
              <QuestInlineLink
                questId={entry.questId}
                className="font-mono-code text-cc-primary hover:underline"
                stopPropagation
              />
              {!entry.explicit && <span className="text-cc-muted/50">detected</span>}
            </span>
          )),
        )}
      </div>
    </div>
  );
}

function groupRelatedQuests(
  relatedQuests: QuestRelatedQuest[],
): Array<[DisplayedQuestRelationshipKind, QuestRelatedQuest[]]> {
  return RELATIONSHIP_ORDER.map((kind) => [kind, relatedQuests.filter((entry) => entry.kind === kind)]).filter(
    (entry): entry is [DisplayedQuestRelationshipKind, QuestRelatedQuest[]] => entry[1].length > 0,
  );
}
