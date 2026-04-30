import { useEffect } from "react";
import { useStore } from "../../store.js";
import { QuestStatusPanel } from "../QuestStatusPanel.js";

export function PlaygroundQuestStatusPanelDemo({ variant }: { variant: "claimed" | "board-attention" }) {
  const sessionId = variant === "claimed" ? "playground-quest-status-claimed" : "playground-quest-status-board";

  useEffect(() => {
    useStore.setState((state) => {
      const sessions = new Map(state.sessions);
      const sdkSessions = state.sdkSessions.filter(
        (session) =>
          ![
            "playground-quest-status-claimed",
            "playground-quest-status-board",
            "playground-quest-status-worker",
          ].includes(session.sessionId),
      );
      const sessionNames = new Map(state.sessionNames);
      const sessionBoards = new Map(state.sessionBoards);
      const quests = state.quests.filter((quest) => !["q-941", "q-88"].includes(quest.questId));
      const baseSession = {
        session_id: "playground-quest-status-claimed",
        backend_type: "codex" as const,
        model: "gpt-5.5",
        cwd: "/Users/stan/Dev/takode",
        tools: [],
        permissionMode: "default",
        claude_code_version: "",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 4,
        context_used_percent: 18,
        is_compacting: false,
        git_branch: "feature/right-panel",
        is_worktree: true,
        is_containerized: false,
        repo_root: "/Users/stan/Dev/takode",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      };

      sessions.set("playground-quest-status-claimed", {
        ...baseSession,
        claimedQuestId: "q-941",
        claimedQuestTitle: "Implement first milestone of left-right orchestration UI",
        claimedQuestStatus: "done",
        claimedQuestVerificationInboxUnread: true,
      });
      sessions.set("playground-quest-status-board", {
        ...baseSession,
        session_id: "playground-quest-status-board",
      });
      sessions.set("playground-quest-status-worker", {
        ...baseSession,
        session_id: "playground-quest-status-worker",
        claimedQuestId: "q-88",
        claimedQuestTitle: "Propose compact Journey handoff",
        claimedQuestStatus: "in_progress",
      });

      sdkSessions.push(
        {
          sessionId: "playground-quest-status-claimed",
          state: "running",
          cwd: "/Users/stan/Dev/takode",
          createdAt: Date.now() - 600000,
          backendType: "codex",
          sessionNum: 1197,
        },
        {
          sessionId: "playground-quest-status-board",
          state: "running",
          cwd: "/Users/stan/Dev/takode",
          createdAt: Date.now() - 480000,
          backendType: "codex",
          isOrchestrator: true,
          sessionNum: 1132,
        },
        {
          sessionId: "playground-quest-status-worker",
          state: "running",
          cwd: "/Users/stan/Dev/takode",
          createdAt: Date.now() - 420000,
          backendType: "codex",
          sessionNum: 1201,
        },
      );
      sessionNames.set("playground-quest-status-worker", "Compact Journey Worker");

      quests.push(
        {
          id: "q-941-v3",
          questId: "q-941",
          version: 3,
          title: "Implement first milestone of left-right orchestration UI",
          status: "done",
          description: "Make quest/status facts visible in the right-side surface.",
          createdAt: Date.now() - 86400000,
          previousOwnerSessionIds: ["playground-quest-status-claimed"],
          claimedAt: Date.now() - 3600000,
          completedAt: Date.now() - 600000,
          verificationInboxUnread: true,
          verificationItems: [
            { text: "Quest summary visible", checked: true },
            { text: "Leader instructions updated", checked: false },
          ],
          feedback: [
            {
              author: "human",
              text: "Clarify the selected context.",
              ts: Date.now() - 120000,
              addressed: false,
            },
          ],
          commitShas: ["abc1234def5678"],
        },
        {
          id: "q-88-v1",
          questId: "q-88",
          version: 1,
          title: "Propose compact Journey handoff",
          status: "in_progress",
          description: "Future richer Journey drafting workflow.",
          createdAt: Date.now() - 7200000,
          sessionId: "playground-quest-status-worker",
          claimedAt: Date.now() - 3600000,
        },
      );

      sessionBoards.set("playground-quest-status-board", [
        {
          questId: "q-88",
          title: "Propose compact Journey handoff",
          worker: "playground-quest-status-worker",
          workerNum: 1201,
          status: "PROPOSED",
          waitForInput: ["n-17"],
          updatedAt: Date.now() - 60000,
          journey: {
            phaseIds: ["alignment", "explore", "mental-simulation", "implement", "code-review", "port"],
            mode: "proposed",
          },
        },
      ]);

      return {
        ...state,
        sessions,
        sdkSessions,
        sessionNames,
        sessionBoards,
        quests,
      };
    });
  }, []);

  return (
    <div className="w-[280px] overflow-hidden rounded-lg border border-cc-border bg-cc-card">
      <QuestStatusPanel sessionId={sessionId} />
    </div>
  );
}
