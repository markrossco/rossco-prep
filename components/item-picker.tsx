'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * Search-as-you-type item box that works on phones. Type part of a name, tap a match.
 * The box holds the exact item name, which is what the server looks up.
 */
export default function ItemPicker({
  names,
  name = 'item_name',
  id = 'item_name',
  placeholder = 'Start typing the name',
}: {
  names: string[]
  name?: string
  id?: string
  placeholder?: string
}) {
  const [value, setValue] = useState('')
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const form = anchor.current?.closest('form')
    if (!form) return
    const clear = () => {
      setValue('')
      setOpen(false)
    }
    form.addEventListener('reset', clear)
    return () => form.removeEventListener('reset', clear)
  }, [])

  const matches = useMemo(() => {
    const words = value.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return []
    return names.filter((n) => {
      const l = n.toLowerCase()
      return words.every((w) => l.includes(w))
    })
  }, [value, names])

  const exact = names.includes(value)

  return (
    <div ref={anchor} className="picker">
      <input
        id={id}
        name={name}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
      />
      {open && value.trim() && !exact && (
        <ul className="picker-list" role="listbox">
          {matches.slice(0, 8).map((n) => (
            <li key={n}>
              <button
                type="button"
                className="picker-option"
                onClick={() => {
                  setValue(n)
                  setOpen(false)
                }}
              >
                {n}
              </button>
            </li>
          ))}
          {matches.length === 0 && <li className="picker-empty">No item matches. Try fewer or different words.</li>}
          {matches.length > 8 && <li className="picker-empty">{matches.length - 8} more. Type more words to narrow it down.</li>}
        </ul>
      )}
    </div>
  )
}
