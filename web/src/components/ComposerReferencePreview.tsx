import { QuestInlineLink } from "./QuestInlineLink.js";
import { SessionInlineLink } from "./SessionInlineLink.js";
import type { PlainTakodeReference } from "./composer-reference-utils.js";

const LINK_CLASS =
  "inline-flex max-w-[160px] items-center rounded-md border border-cc-border/70 bg-cc-hover/45 px-1.5 py-0.5 font-mono-code text-[11px] leading-4 text-cc-primary transition-colors hover:border-cc-primary/40 hover:bg-cc-primary/10 hover:no-underline";

export function ComposerReferencePreview({ references }: { references: PlainTakodeReference[] }) {
  if (references.length === 0) return null;

  const visibleReferences = references.slice(0, 6);
  const hiddenCount = references.length - visibleReferences.length;

  return (
    <div
      data-testid="composer-reference-preview"
      aria-label="Detected references"
      className="mx-2 mb-1.5 flex flex-wrap items-center gap-1.5 border-t border-cc-border/40 px-2 pt-2"
    >
      {visibleReferences.map((reference) =>
        reference.kind === "quest" ? (
          <QuestInlineLink key={`quest:${reference.questId}`} questId={reference.questId} className={LINK_CLASS}>
            <span className="truncate">{reference.text}</span>
          </QuestInlineLink>
        ) : (
          <SessionInlineLink
            key={`session:${reference.sessionNum}`}
            sessionId={null}
            sessionNum={reference.sessionNum}
            className={LINK_CLASS}
            missingClassName={`${LINK_CLASS} text-cc-muted`}
          >
            <span className="truncate">{reference.text}</span>
          </SessionInlineLink>
        ),
      )}
      {hiddenCount > 0 && (
        <span className="rounded-md border border-cc-border/50 bg-cc-hover/30 px-1.5 py-0.5 text-[11px] leading-4 text-cc-muted">
          +{hiddenCount}
        </span>
      )}
    </div>
  );
}
