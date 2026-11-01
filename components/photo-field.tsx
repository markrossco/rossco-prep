'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

/** Shrinks a phone photo to a sensible size (long edge 1600px, JPEG) so it uploads fast on site. */
async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not prepare the photo.')
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not prepare the photo.'))), 'image/jpeg', 0.82),
  )
}

/**
 * Photo picker for the report forms. On a phone it opens the camera.
 * It uploads straight to the private photo store and puts the file's path in a hidden field of the form.
 */
export default function PhotoField({ name = 'photo_path' }: { name?: string }) {
  const [path, setPath] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)

  // When the form is cleared after a successful report, forget the photo too
  useEffect(() => {
    const form = anchor.current?.closest('form')
    if (!form) return
    const clear = () => {
      setPath('')
      setStatus('')
    }
    form.addEventListener('reset', clear)
    return () => form.removeEventListener('reset', clear)
  }, [])

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    setPath('')
    setStatus('Preparing the photo…')
    try {
      let blob: Blob
      try {
        blob = await shrink(file)
      } catch {
        if (file.size > 4_000_000) throw new Error('That photo is too big and could not be shrunk. Try another.')
        blob = file
      }
      const supabase = createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) throw new Error('Please sign in again.')
      const p = `${user.id}/${crypto.randomUUID()}.jpg`
      setStatus('Uploading…')
      const { error } = await supabase.storage.from('issue-photos').upload(p, blob, { contentType: 'image/jpeg' })
      if (error) throw new Error(error.message)
      setPath(p)
      setStatus('Photo attached.')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'The photo did not upload.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={anchor}>
      <label htmlFor={`${name}-file`}>Photo (optional)</label>
      <input id={`${name}-file`} type="file" accept="image/*" capture="environment" onChange={onPick} />
      <input type="hidden" name={name} value={path} />
      {status && (
        <p className={path ? 'ok-text' : busy ? 'muted' : 'error'} role="status" style={{ marginTop: 6 }}>
          {status}
          {busy ? ' Wait until it says "Photo attached" before reporting.' : ''}
        </p>
      )}
    </div>
  )
}
