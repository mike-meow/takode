export interface VoiceEditProposal {
  originalText: string;
  editedText: string;
  instructionText: string;
}

export interface FailedTranscription {
  blob: Blob;
  mode: "dictation" | "edit" | "append";
  composerText: string;
  cursorContext: { before: string; after: string };
}
