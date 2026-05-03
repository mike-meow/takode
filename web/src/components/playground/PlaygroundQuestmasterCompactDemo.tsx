import { useEffect } from "react";
import type { QuestJourneyPhaseId } from "../../../shared/quest-journey.js";
import { useStore } from "../../store.js";
import { QuestmasterPage } from "../QuestmasterPage.js";

const JOURNEY_PHASE_CYCLE: QuestJourneyPhaseId[] = [
  "alignment",
  "explore",
  "implement",
  "code-review",
  "user-checkpoint",
  "port",
  "execute",
  "outcome-review",
];

function buildLongJourneyPhaseIds(): QuestJourneyPhaseId[] {
  return Array.from({ length: 38 }, (_, index) => JOURNEY_PHASE_CYCLE[index % JOURNEY_PHASE_CYCLE.length]);
}

export function PlaygroundQuestmasterCompactDemo() {
  useEffect(() => {
    useStore.setState((state) => {
      const now = Date.now();
      const longJourneyPhaseIds = buildLongJourneyPhaseIds();
      const quests = state.quests.filter((quest) => !["q-901", "q-902"].includes(quest.questId));
      const sessionBoards = new Map(state.sessionBoards);
      const leaderBoard = (sessionBoards.get("playground-questmaster-leader") ?? []).filter(
        (row) => row.questId !== "q-902",
      );
      sessionBoards.set("playground-questmaster-leader", [
        {
          questId: "q-902",
          title: "Simplify Questmaster compact status",
          worker: "playground-questmaster-worker",
          workerNum: 902,
          status: "IMPLEMENTING",
          updatedAt: now - 15_000,
          journey: {
            mode: "active",
            phaseIds: longJourneyPhaseIds,
            currentPhaseId: longJourneyPhaseIds[20],
            activePhaseIndex: 20,
            phaseNotes: {
              "15": "Visible clamp boundary note in the default hover window.",
              "31": "Later phase note appears after expanding omitted phases.",
            },
          },
        },
        ...leaderBoard,
      ]);

      return {
        quests: [
          {
            id: "q-901-v3",
            questId: "q-901",
            version: 3,
            title: "Completed verification uses Verify column",
            status: "done" as const,
            description: "Keep manual verification visible without Status saying Inbox.",
            tldr: "Completed row references [q-986](quest:q-986) and keeps verification separated from Status, even when this TLDR wraps across authoring lines.",
            createdAt: now - 300_000,
            statusChangedAt: now - 200_000,
            updatedAt: now - 10_000,
            sessionId: "playground-questmaster-worker",
            claimedAt: now - 260_000,
            completedAt: now - 120_000,
            verificationInboxUnread: true,
            verificationItems: [
              { text: "Verify completed status copy", checked: false },
              { text: "Verify TLDR links render", checked: true },
            ],
            debriefTldr: "This debrief is intentionally absent from compact title cells.",
            tags: ["ui", "questmaster"],
          },
          {
            id: "q-902-v1",
            questId: "q-902",
            version: 1,
            title: "Active Journey phase appears in Status",
            status: "in_progress" as const,
            description: "Active Journey rows show the current phase in Status.",
            tldr: "Hover the active status to inspect a long Quest Journey preview clamped around the current phase.",
            createdAt: now - 240_000,
            statusChangedAt: now - 180_000,
            updatedAt: now - 15_000,
            sessionId: "playground-questmaster-worker",
            leaderSessionId: "playground-questmaster-leader",
            claimedAt: now - 180_000,
            tags: ["ui", "quest-journey"],
          },
          ...quests,
        ],
        sessionBoards,
        sdkSessions: [
          ...state.sdkSessions.filter(
            (session) =>
              !["playground-questmaster-worker", "playground-questmaster-leader"].includes(session.sessionId),
          ),
          {
            sessionId: "playground-questmaster-worker",
            sessionNum: 902,
            state: "connected" as const,
            cwd: "/tmp/playground",
            createdAt: now - 240_000,
            archived: false,
          },
          {
            sessionId: "playground-questmaster-leader",
            sessionNum: 1286,
            state: "connected" as const,
            cwd: "/tmp/playground",
            createdAt: now - 300_000,
            archived: false,
          },
        ],
        questmasterViewMode: "compact" as const,
        questmasterCompactSort: { column: "updated" as const, direction: "desc" as const },
        questmasterSearchQuery: "",
        questmasterSelectedTags: [],
      };
    });
  }, []);

  return (
    <div className="h-[520px] overflow-hidden rounded-xl border border-cc-border bg-cc-bg">
      <QuestmasterPage isActive={false} />
    </div>
  );
}
