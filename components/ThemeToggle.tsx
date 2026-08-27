'use client'

import * as React from 'react'
import { Moon, Sun, Monitor } from 'lucide-react'
import { useTheme } from 'next-themes'

/**
 * ThemeToggle – Client Component
 *
 * A header button that cycles the app between dark, light, and system modes.
 * The choice is delegated to next-themes, which persists it to localStorage (under the
 * `trustlend-theme` key) and applies the `.dark` class before paint.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => setMounted(true), [])

  const currentTheme = theme || 'system'

  return (
    <button
      onClick={() => {
        if (currentTheme === 'dark') setTheme('light')
        else if (currentTheme === 'light') setTheme('system')
        else setTheme('dark')
      }}
      className="relative h-9 w-9 rounded-full transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
      aria-label={mounted ? `Theme: ${currentTheme}. Click to switch.` : 'Toggle theme'}
      title={mounted ? `Theme: ${currentTheme}. Click to switch.` : undefined}
      suppressHydrationWarning
    >
      <Sun className={`absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 transition-all ${mounted && currentTheme === 'light' ? 'rotate-0 scale-100' : '-rotate-90 scale-0'}`} />
      <Moon className={`absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 transition-all ${mounted && currentTheme === 'dark' ? 'rotate-0 scale-100' : 'rotate-90 scale-0'}`} />
      <Monitor className={`absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 transition-all ${(!mounted || currentTheme === 'system') ? 'rotate-0 scale-100' : 'rotate-90 scale-0'}`} />
    </button>
  )
}
