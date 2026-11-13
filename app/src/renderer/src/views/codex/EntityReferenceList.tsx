import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { rpc } from '../../rpc/client'
import './entity-reference-list.css'

type Entry = { id: string; name: string }

function selectedIds(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value || '[]')
    return Array.isArray(parsed) && parsed.every((id): id is string => typeof id === 'string')
      ? [...new Set(parsed)] : null
  } catch {
    return null
  }
}

/** Case-insensitive substring, then ordered-character fuzzy for short typos. */
function matchesQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const n = name.toLowerCase()
  if (n.includes(q)) return true
  let i = 0
  for (const ch of n) {
    if (ch === q[i]) i++
    if (i >= q.length) return true
  }
  return false
}

/** `[North, Reach], [Gaspard]` → tokens; commas inside brackets stay in the name. */
function parseBracketTokens(text: string): string[] | null {
  const tokens: string[] = []
  const re = /\[([^\]]*)\]/g
  let match: RegExpExecArray | null
  let found = false
  while ((match = re.exec(text)) !== null) {
    found = true
    const token = match[1].trim()
    if (token) tokens.push(token)
  }
  return found ? tokens : null
}

function resolveName(catalog: Entry[], name: string): Entry[] {
  const needle = name.trim().toLowerCase()
  return catalog.filter(entry => entry.name.toLowerCase() === needle)
}

export function EntityReferenceList({ targetType, label, value, onChange, editable = true }: {
  targetType: string
  label: string
  value: string
  onChange: (value: string) => void | Promise<void>
  editable?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const listboxId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [error, setError] = useState('')
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingValue, setPendingValue] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const ids = selectedIds(pendingValue ?? value)

  useEffect(() => {
    let active = true
    setEntries([])
    setError('')
    void rpc.request<Entry[]>('entities/list', [targetType])
      .then((items) => { if (active) setEntries(items) })
      .catch((cause: unknown) => { if (active) setError(String(cause)) })
    return () => { active = false }
  }, [targetType])

  const change = async (next: string[]): Promise<void> => {
    if (!editable) return
    const serialized = JSON.stringify(next)
    setPendingValue(serialized)
    setError('')
    setHint('')
    try {
      const pending = onChange(serialized)
      if (pending) {
        setBusy(true)
        await pending
      }
    } catch (cause) {
      setError(String(cause))
    } finally {
      setPendingValue(null)
      setBusy(false)
    }
  }

  const selected: Entry[] = (ids ?? []).map(id => {
    const found = entries.find(entry => entry.id === id)
    return found ?? { id, name: t('entityTypeManager.unavailableReference') }
  })
  const selectedSet = new Set(ids ?? [])
  const suggestions = entries
    .filter(entry => !selectedSet.has(entry.id) && matchesQuery(entry.name, query))
    .slice(0, 50)
  const canEdit = editable && !busy

  const addEntry = (entry: Entry): void => {
    if (!ids || selectedSet.has(entry.id) || !canEdit) return
    setQuery('')
    setOpen(false)
    setActiveIndex(0)
    void change([...ids, entry.id])
  }

  const removeEntry = (id: string): void => {
    if (!ids || !canEdit) return
    void change(ids.filter(item => item !== id))
  }

  const commitQuery = (): boolean => {
    const trimmed = query.trim()
    if (!trimmed || !ids || !canEdit) return false
    const exact = resolveName(entries.filter(entry => !selectedSet.has(entry.id)), trimmed)
    if (exact.length === 1) {
      addEntry(exact[0])
      return true
    }
    if (exact.length > 1) {
      setHint(t('entityTypeManager.ambiguousReference', { name: trimmed }))
      setOpen(true)
      return false
    }
    if (suggestions.length === 1) {
      addEntry(suggestions[0])
      return true
    }
    if (suggestions.length === 0) {
      setHint(t('entityTypeManager.noReferenceMatch', { name: trimmed }))
      return false
    }
    setHint(t('entityTypeManager.pickReferenceMatch'))
    setOpen(true)
    return false
  }

  const applyBracketPaste = (text: string): boolean => {
    const tokens = parseBracketTokens(text)
    if (!tokens || !ids || !canEdit) return false
    const next = [...ids]
    const problems: string[] = []
    for (const token of tokens) {
      const matches = resolveName(entries, token).filter(entry => !next.includes(entry.id))
      if (matches.length === 1) next.push(matches[0].id)
      else if (matches.length === 0) problems.push(t('entityTypeManager.noReferenceMatch', { name: token }))
      else problems.push(t('entityTypeManager.ambiguousReference', { name: token }))
    }
    if (next.length !== ids.length) void change(next)
    setHint(problems[0] ?? '')
    setQuery('')
    setOpen(false)
    return true
  }

  useEffect(() => {
    setActiveIndex(0)
  }, [query, open, suggestions.length])

  return <div className="entity-reference-list" role="group" aria-label={label}>
    {error && <p role="alert">{error}</p>}
    {ids === null ? <>
      <p role="alert">{t('entityTypeManager.invalidReferenceList')}</p>
      <button className="dialog-button" onClick={() => void change([])} disabled={busy} aria-disabled={!editable}>
        {t('entityTypeManager.clearReferences')}
      </button>
    </> : <>
      <div className="entity-reference-list-chips">
        {selected.map(entry =>
          <span key={entry.id} className="entity-chip" data-ref-id={entry.id}>
            {entry.name}
            <button
              type="button"
              aria-label={`${t('explorer.contextDelete')} ${entry.name}`}
              aria-disabled={!canEdit}
              disabled={!canEdit}
              onClick={() => removeEntry(entry.id)}
            >
              <X size={11} strokeWidth={2} />
            </button>
          </span>
        )}
        {entries.length === 0 && selected.length === 0 && (
          <span className="entity-reference-list-empty">{t('codexHub.emptyHint')}</span>
        )}
        <div className="entity-reference-list-combobox">
          <input
            ref={inputRef}
            className="entity-reference-list-input"
            role="combobox"
            aria-label={t('entityTypeManager.addReference')}
            aria-expanded={open && suggestions.length > 0}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-disabled={!editable}
            disabled={busy}
            readOnly={!editable}
            value={query}
            placeholder={t('entityTypeManager.addReference')}
            onFocus={() => { if (canEdit) setOpen(true) }}
            onBlur={() => {
              // Delay so option click can register before the list unmounts.
              window.setTimeout(() => setOpen(false), 120)
            }}
            onChange={event => {
              if (!canEdit) return
              setQuery(event.target.value)
              setHint('')
              setOpen(true)
            }}
            onPaste={event => {
              const text = event.clipboardData.getData('text')
              if (parseBracketTokens(text)) {
                event.preventDefault()
                applyBracketPaste(text)
              }
            }}
            onKeyDown={event => {
              if (!canEdit) {
                if (event.key !== 'Tab') event.preventDefault()
                return
              }
              if (event.key === 'ArrowDown' && suggestions.length > 0) {
                event.preventDefault()
                setOpen(true)
                setActiveIndex(index => (index + 1) % suggestions.length)
              } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
                event.preventDefault()
                setOpen(true)
                setActiveIndex(index => (index - 1 + suggestions.length) % suggestions.length)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                if (open && suggestions[activeIndex]) addEntry(suggestions[activeIndex])
                else commitQuery()
              } else if (event.key === 'Escape') {
                setOpen(false)
              } else if (event.key === 'Backspace' && query === '' && selected.length > 0) {
                event.preventDefault()
                removeEntry(selected[selected.length - 1].id)
              }
            }}
          />
          {open && canEdit && suggestions.length > 0 && (
            <ul className="entity-reference-list-suggestions" role="listbox" id={listboxId}>
              {suggestions.map((entry, index) =>
                <li key={entry.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    className={index === activeIndex ? 'active' : undefined}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => addEntry(entry)}
                  >
                    {entry.name}
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
      {hint && <p className="entity-reference-list-hint" role="status">{hint}</p>}
    </>}
  </div>
}
