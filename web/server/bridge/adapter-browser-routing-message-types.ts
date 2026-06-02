import type { ImageRef } from "../image-store.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage } from "../session-types.js";

export type InterruptSource = "user" | "leader" | "system";

export type ControlResponseHandler = {
  subtype: string;
  resolve: (response: unknown) => void;
};

export type BrowserUserMessage = Extract<BrowserOutgoingMessage, { type: "user_message" }>;

export type PermissionResponseMessage = Extract<BrowserOutgoingMessage, { type: "permission_response" }>;

export type IngestedUserMessage = {
  timestamp: number;
  historyEntry: Extract<BrowserIncomingMessage, { type: "user_message" }>;
  historyIndex: number;
  imageRefs?: ImageRef[];
  needsInputReminderText?: string;
  needsInputResolutionNoticeText?: string;
  needsInputResolutionNoticeIds?: string[];
  wasGenerating: boolean;
};
