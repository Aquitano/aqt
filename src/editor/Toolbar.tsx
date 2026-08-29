import { useState } from 'react'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowUpToLine,
  BookOpen,
  Check,
  ImagePlus,
  Plus,
  Redo2,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { PhotoElement, PhotoFrame, TextElement } from '@/domain/element'
import { cn } from '@/lib/utils'
import { CAPTION_COLORS, MAX_TEXT_SIZE, MIN_TEXT_SIZE, targetPage, textElementFor } from './place'
import { useEditor, useEditorTemporal, type SaveStatus } from './store'

const FRAMES: readonly PhotoFrame[] = ['none', 'polaroid', 'corners', 'tape']

/** Floating edit controls, docked below the book. */
export function Toolbar() {
  const spreads = useEditor((state) => state.spreads)
  const current = useEditor((state) => state.current)
  const selection = useEditor((state) => state.selection)
  const setMode = useEditor((state) => state.setMode)
  const setPanel = useEditor((state) => state.setPanel)
  const addElement = useEditor((state) => state.addElement)
  const select = useEditor((state) => state.select)
  const setEditing = useEditor((state) => state.setEditing)
  const insertSpread = useEditor((state) => state.insertSpread)
  const removeSpread = useEditor((state) => state.removeSpread)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const spread = spreads[current]
  const selected = spread?.elements.find((el) => el.id === selection)

  const addText = () => {
    if (!spread) return
    const element = textElementFor(targetPage(spread.elements, selection))
    addElement(spread.id, element)
    select(element.id)
    setEditing(element.id)
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
      <Card className="pointer-events-auto flex-row items-center gap-1 px-2 py-1.5 shadow-lg">
        <IconButton label="Add photo" onClick={() => setPanel('photos')} disabled={!spread}>
          <ImagePlus />
        </IconButton>
        <IconButton label="Add text" onClick={addText} disabled={!spread}>
          <Type />
        </IconButton>

        {selected ? (
          <>
            <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-6" />
            {selected.kind === 'photo' ? (
              <PhotoControls element={selected} spreadId={spread.id} />
            ) : (
              <TextControls element={selected} spreadId={spread.id} />
            )}
            <ZOrderControls id={selected.id} spreadId={spread.id} />
          </>
        ) : null}

        <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-6" />
        <IconButton label="Pages" onClick={() => setPanel('pages')}>
          <BookOpen />
        </IconButton>
        <IconButton label="Insert spread after" onClick={() => insertSpread(current)}>
          <Plus />
        </IconButton>
        <IconButton
          label="Delete spread"
          onClick={() => setConfirmDelete(true)}
          disabled={!spread || spreads.length <= 1}
        >
          <Trash2 />
        </IconButton>

        <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-6" />
        <History />
        <SaveDot />
        <Button size="sm" onClick={() => setMode('view')}>
          <Check data-icon="inline-start" />
          Done
        </Button>
      </Card>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this spread?</DialogTitle>
            <DialogDescription>
              Both pages and everything on them go. You can undo this.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (spread) removeSpread(spread.id)
                setConfirmDelete(false)
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function PhotoControls({ element, spreadId }: { element: PhotoElement; spreadId: string }) {
  const updateElement = useEditor((state) => state.updateElement)
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={element.frame}
      onValueChange={(frame) => frame && updateElement(spreadId, element.id, { frame: frame as PhotoFrame })}
      aria-label="Frame"
    >
      {FRAMES.map((frame) => (
        <ToggleGroupItem key={frame} value={frame} className="capitalize">
          {frame}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

function TextControls({ element, spreadId }: { element: TextElement; spreadId: string }) {
  const updateElement = useEditor((state) => state.updateElement)
  const patch = (next: Partial<TextElement>) => updateElement(spreadId, element.id, next)
  return (
    <>
      <ToggleGroup
        type="single"
        size="sm"
        value={element.font}
        onValueChange={(font) => font && patch({ font: font as TextElement['font'] })}
        aria-label="Font"
      >
        <ToggleGroupItem value="hand" style={{ fontFamily: 'var(--font-hand)' }} className="text-base">
          Hand
        </ToggleGroupItem>
        <ToggleGroupItem value="clean">Clean</ToggleGroupItem>
      </ToggleGroup>
      <Slider
        aria-label="Text size"
        className="mx-2 w-24"
        min={MIN_TEXT_SIZE}
        max={MAX_TEXT_SIZE}
        step={2}
        value={[element.size]}
        onValueChange={([size]) => size !== undefined && patch({ size })}
      />
      <div className="flex items-center gap-1" role="radiogroup" aria-label="Colour">
        {CAPTION_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={element.color === color}
            aria-label={color}
            style={{ background: color }}
            onClick={() => patch({ color })}
            className={cn(
              'size-5 rounded-full border border-black/10',
              element.color === color && 'ring-ring ring-2 ring-offset-1',
            )}
          />
        ))}
      </div>
      <ToggleGroup
        type="single"
        size="sm"
        value={element.align}
        onValueChange={(align) => align && patch({ align: align as TextElement['align'] })}
        aria-label="Alignment"
      >
        <ToggleGroupItem value="left" aria-label="Align left">
          <AlignLeft />
        </ToggleGroupItem>
        <ToggleGroupItem value="center" aria-label="Align centre">
          <AlignCenter />
        </ToggleGroupItem>
        <ToggleGroupItem value="right" aria-label="Align right">
          <AlignRight />
        </ToggleGroupItem>
      </ToggleGroup>
    </>
  )
}

function ZOrderControls({ id, spreadId }: { id: string; spreadId: string }) {
  const reorderElement = useEditor((state) => state.reorderElement)
  const removeElement = useEditor((state) => state.removeElement)
  return (
    <>
      <IconButton label="Bring forward" onClick={() => reorderElement(spreadId, id, 'forward')}>
        <ArrowUpToLine />
      </IconButton>
      <IconButton label="Send backward" onClick={() => reorderElement(spreadId, id, 'backward')}>
        <ArrowDownToLine />
      </IconButton>
      <IconButton label="Delete element" onClick={() => removeElement(spreadId, id)}>
        <Trash2 />
      </IconButton>
    </>
  )
}

function History() {
  const canUndo = useEditorTemporal((state) => state.pastStates.length > 0)
  const canRedo = useEditorTemporal((state) => state.futureStates.length > 0)
  const undo = useEditorTemporal((state) => state.undo)
  const redo = useEditorTemporal((state) => state.redo)
  return (
    <>
      <IconButton label="Undo" onClick={() => undo()} disabled={!canUndo}>
        <Undo2 />
      </IconButton>
      <IconButton label="Redo" onClick={() => redo()} disabled={!canRedo}>
        <Redo2 />
      </IconButton>
    </>
  )
}

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: 'Saved',
  saving: 'Saving',
  error: 'Not saved. Edit again to retry.',
}

function SaveDot() {
  const status = useEditor((state) => state.saveStatus)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          aria-label={SAVE_LABEL[status]}
          data-status={status}
          className={cn(
            'mx-2 inline-block size-2 rounded-full',
            status === 'saved' && 'bg-muted-foreground/40',
            status === 'saving' && 'bg-primary animate-pulse',
            status === 'error' && 'bg-destructive',
          )}
        />
      </TooltipTrigger>
      <TooltipContent>{SAVE_LABEL[status]}</TooltipContent>
    </Tooltip>
  )
}

type IconButtonProps = {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}

function IconButton({ label, onClick, disabled, children }: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} disabled={disabled}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
