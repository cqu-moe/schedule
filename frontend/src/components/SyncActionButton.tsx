import { useLayoutEffect, useRef, useState, type ComponentProps } from 'react'
import { ActionButton, Button } from '@cqu-moe/ui'
import { ArrowRight } from 'lucide-react'

type SyncActionButtonProps = Pick<
  ComponentProps<typeof ActionButton>,
  'state' | 'labels' | 'disabled' | 'onClick'
>

/** Size the shared control to its current label without changing its state feedback. */
export default function SyncActionButton(props: SyncActionButtonProps) {
  const measureRef = useRef<HTMLSpanElement>(null)
  const [width, setWidth] = useState<number>()
  const label = props.labels[props.state]

  useLayoutEffect(() => {
    const measure = measureRef.current
    if (!measure) return
    const updateWidth = () => setWidth(measure.getBoundingClientRect().width)
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(measure)
    return () => observer.disconnect()
  }, [label])

  return (
    <span className="dash-sync-action" style={{ width }}>
      {/* A non-interactive sizing copy follows the shared button's font and padding. */}
      <Button asChild variant="outline" className="dash-sync-measure">
        <span ref={measureRef} aria-hidden="true" inert>
          <span className="dash-sync-measure-content">
            <ArrowRight />
            {label}
          </span>
        </span>
      </Button>
      <ActionButton {...props} variant="outline" className="dash-sync-button" />
    </span>
  )
}
