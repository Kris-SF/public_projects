import * as React from "react"
import { cn } from "@/lib/utils"

export interface SliderProps {
  value?: number[]
  onValueChange?: (value: number[]) => void
  min?: number
  max?: number
  step?: number
  className?: string
}

const Slider = React.forwardRef<HTMLDivElement, SliderProps>(
  ({ value = [0], onValueChange, min = 0, max = 100, step = 1, className }, ref) => {
    return (
      <div ref={ref} className={cn("relative flex w-full touch-none select-none items-center", className)}>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value[0]}
          onChange={(e) => onValueChange?.([parseFloat(e.target.value)])}
          className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer"
        />
      </div>
    )
  }
)
Slider.displayName = "Slider"

export { Slider }
