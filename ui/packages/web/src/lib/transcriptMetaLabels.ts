// Tool activity and transcript thoughts are peer progress rows. Keep their regular type scale,
// light-grey tone, and line box shared so alternating `N tool calls` / `Thought for Ns` rows have
// one rhythm without making thought metadata look like a separate petite-caps label system.
//
// 14px is the ASSISTANT PROSE size (`.md-body` in styles.css), and these rows deliberately match it
// (maintainer 2026-07-31, on a shot of `Ran 2 tool calls` above a reply: "is this the same font size?
// shoudl be"). They sat at 13px, which read as a second, smaller type scale interleaved with the
// prose rather than as the same column speaking quietly — the tone, not the size, is what makes these
// rows recede. Any glyph sized against this line must be `1em` so it follows.
export const TRANSCRIPT_META_LABEL_CLASS = "text-[14px] leading-5 text-muted"
