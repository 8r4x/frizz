import type { ReactNode } from "react"

// THE frame every rendered image sits in — a screenshot a tool returned, a picture a worker delivered, a
// path the agent wrote on its own line, a file the human attached. One element so they cannot drift: an
// outer border in the tool-card family, a little inset padding (the mat), and the picture centered inside
// it. Optional `header` is a label bar INSIDE that border (the tool name + target + status), so an image
// card is one framed object rather than a bordered card with a separately bordered picture nested in it.
//
// The frame SPANS the message width and centers the picture inside the mat, rather than shrink-wrapping
// it. Shrink-wrapping was tried first and is what "consistent frame" rules out: two image Reads in one
// turn measured 323px and 678px wide, so a column of screenshots painted a ragged stack of boxes with no
// shared edge — while every other tool card in the transcript runs full width. A spanning frame puts them
// all on the same left and right rules, which is the whole point of having one element.
//
// The mat is `--color-panel-2`, a step LIGHTER than the card background, and it is doing real work rather
// than decoration: agent screenshots are overwhelmingly dark UI, so on the page background their own edges
// vanish and the picture bleeds into its frame. The lighter mat gives every shot a visible boundary
// without nesting a second border 6px inside the first.
//
// `fray-bash` supplies the chrome AND the typography of the tool-card family (1px border, block radius,
// mono 12.5px). Carrying the class rather than re-declaring those in Tailwind is what lets
// `fray-bash-header` sit inside this frame and render identically to a Bash / Read / Edit header.
export function ImageFrame({ header, caption, children }: { header?: ReactNode; caption?: ReactNode; children: ReactNode }) {
  return (
    <figure className="fray-bash max-w-full">
      {header}
      <div className="flex justify-center bg-panel-2 p-1.5">{children}</div>
      {caption}
    </figure>
  )
}

// The picture inside the frame: never wider than the mat, never taller than a screenful, always keeping
// its intrinsic aspect. Shared so the frame's contents are as consistent as the frame itself.
export const FRAMED_IMAGE = "block max-h-[420px] max-w-full w-auto rounded-md object-contain"
