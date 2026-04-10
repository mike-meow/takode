---
name: random-memory-ideas
description: "Use when the user wants to remember, capture, save, or add a random idea, thought, note, link, reference, decision, or memory to Yuege's Random Memory Hub in Notion."
---

# Random Memory Ideas

Capture loose ideas and memories into the private Notion page **Random Memory Hub**.

## Destination

- Preferred page: `Random Memory Hub`
- Preferred URL: `https://www.notion.so/33e8e50b62b081d58a92c9eeeaf27807`
- Preferred page ID: `33e8e50b-62b0-81d5-8a92-c9eeeaf27807`
- Expected parent: `Yuege's Home Page`

If the preferred page ID cannot be fetched, search Notion for the exact title `Random Memory Hub`. Use the result only if it is clearly the memory hub under `Yuege's Home Page`; otherwise ask the user for the correct destination.

## Workflow

1. Use this skill when the user asks to save or remember a random idea, thought, link, snippet, reference, decision, or miscellaneous memory.
2. If the user already gave the content, do not ask for confirmation. Ask a brief follow-up only when the actual memory to save is unclear.
3. Use Notion only. Do not post to Slack, email, GitHub, or other apps unless the user separately requests that.
4. Fetch `Random Memory Hub` first with the Notion fetch tool so you can update the current page content without overwriting newer edits. If the preferred page ID is stale, use the destination fallback above.
5. Add the new entry near the top of the `Quick Capture` section, preserving the capture template and all existing page content.
6. Use `notion_update_page` with `command: "update_content"` and an exact `old_str` from the fetched page.
7. Fetch the page again after updating and report the Notion link plus the exact entry added.

## Entry Format

Prefer a compact, searchable bullet:

```markdown
- YYYY-MM-DD: <memory>
  - Context: <why it matters or where it came from>
  - Source: <link or source, if provided>
  - Tags: #idea #reference
```

Rules:

- Use the current local date.
- Omit fields that are genuinely unknown instead of writing placeholders like `unknown`.
- Keep the user's wording when it is already clear.
- Add 1-4 tags based on the content. Prefer these tags: `#idea`, `#reference`, `#decision`, `#follow-up`, `#project`, `#person`, `#someday`, `#misc`.
- If the memory is a direct decision, include `#decision`; if it requires action later, include `#follow-up`.

## Failure Cases

- If the Notion page cannot be fetched or updated because of permissions, say that directly and ask for access or a new destination.
- If the page structure no longer contains `Quick Capture`, append a short `# Quick Capture` section to the end instead of guessing another destination.
