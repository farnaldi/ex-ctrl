'use client';
import { useId, useState, useTransition } from 'react';
import { updateTx } from '../actions';
import { useSaveToast } from './use-save-toast';

export type EditorOptions = {
  categories: { name: string; nature: string }[];
  tags: { name: string; parent: string | null }[];
  merchants: string[];
  commitments: { id: number; description: string }[];
};

export type EditableTransaction = {
  id: number;
  category: string | null;
  merchant: string | null;
  note: string | null;
  one_off: boolean;
  commitment_id: number | null;
  tags: string[];
  is_spending: boolean;
};

/** Same normalization as the TagName schema: one lowercase word. */
const tagName = (v: string) => v.trim().toLowerCase().replace(/\s+/g, '-');
const orNull = (v: string) => (v.trim() === '' ? null : v.trim());

/**
 * Edit form shared by the drawer and the detail page (desktop only: phones get the read-only view).
 * Sends only what changed, as one save → one operation → one "Deshacer". The parent remounts it (key) when the
 * server data changes, e.g. after an undo, so the fields always start from what is stored.
 */
export function TransactionForm({ tx, options }: { tx: EditableTransaction; options: EditorOptions }) {
  const id = useId();
  const [category, setCategory] = useState(tx.category ?? '');
  const [merchant, setMerchant] = useState(tx.merchant ?? '');
  const [note, setNote] = useState(tx.note ?? '');
  const [oneOff, setOneOff] = useState(tx.one_off);
  const [commitment, setCommitment] = useState(tx.commitment_id ? String(tx.commitment_id) : '');
  const [tags, setTags] = useState(tx.tags);
  const [tagDraft, setTagDraft] = useState('');
  const [pending, startTransition] = useTransition();
  const saved = useSaveToast();

  const changes: Record<string, unknown> = {};
  if (orNull(category) !== tx.category) changes.category = orNull(category);
  if (orNull(merchant) !== tx.merchant) changes.merchant = orNull(merchant);
  if (orNull(note) !== (tx.note === null ? null : tx.note.trim())) changes.note = orNull(note);
  if (oneOff !== tx.one_off) changes.one_off = oneOff;
  if ((commitment ? Number(commitment) : null) !== tx.commitment_id) changes.commitment_id = commitment ? Number(commitment) : null;
  if ([...tags].sort().join() !== [...tx.tags].sort().join()) changes.tags = tags;
  const dirty = Object.keys(changes).length > 0;

  const knownCategory = options.categories.some((c) => c.name.toLowerCase() === category.trim().toLowerCase());
  const knownTags = new Set(options.tags.map((t) => t.name));

  function addTag(raw: string) {
    const names = raw.split(',').map(tagName).filter(Boolean);
    if (names.length) setTags((xs) => [...new Set([...xs, ...names])]);
    setTagDraft('');
  }

  function save() {
    if (!dirty || pending) return;
    const finalMerchant = 'merchant' in changes ? (changes.merchant as string | null) : tx.merchant;
    const newCategory = 'category' in changes ? (changes.category as string | null) : undefined;
    startTransition(async () => {
      const r = await updateTx({ transaction_id: tx.id, ...changes });
      saved(r, {
        categoryChange: newCategory && finalMerchant ? { merchant: finalMerchant, from: tx.category, to: newCategory } : null,
      });
    });
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); save(); }}
      onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } }}
      className="grid gap-4 text-sm"
    >
      <label className="grid gap-1">
        <span className="text-xs text-muted">Categoría</span>
        <input value={category} onChange={(e) => setCategory(e.target.value)} list={`${id}-cat`} placeholder="Sin categoría" className="field" autoComplete="off" />
        <datalist id={`${id}-cat`}>{options.categories.map((c) => <option key={c.name} value={c.name} />)}</datalist>
        {category.trim() && !knownCategory && <span className="text-xs text-muted">Se crea la categoría “{category.trim()}” (variable).</span>}
      </label>

      <div className="grid gap-1">
        <label htmlFor={`${id}-tag`} className="text-xs text-muted">Tags</label>
        <div className="field flex flex-wrap items-center gap-1.5">
          {tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-0.5 text-xs">
              #{t}
              <button type="button" onClick={() => setTags((xs) => xs.filter((x) => x !== t))} aria-label={`Quitar ${t}`} className="text-muted hover:text-danger">×</button>
            </span>
          ))}
          <input
            id={`${id}-tag`}
            value={tagDraft}
            onChange={(e) => (e.target.value.endsWith(',') ? addTag(e.target.value) : setTagDraft(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && tagDraft.trim()) { e.preventDefault(); addTag(tagDraft); }
              if (e.key === 'Backspace' && !tagDraft && tags.length) setTags((xs) => xs.slice(0, -1));
            }}
            onBlur={() => tagDraft.trim() && addTag(tagDraft)}
            list={`${id}-tags`}
            placeholder={tags.length ? '' : 'Agregar tag'}
            className="min-w-24 flex-1 bg-transparent outline-none"
            autoComplete="off"
          />
        </div>
        <datalist id={`${id}-tags`}>
          {options.tags.filter((t) => !tags.includes(t.name)).map((t) => <option key={t.name} value={t.name}>{t.parent ? `${t.parent} › ${t.name}` : t.name}</option>)}
        </datalist>
        {tags.some((t) => !knownTags.has(t)) && <span className="text-xs text-muted">Tags nuevos: {tags.filter((t) => !knownTags.has(t)).map((t) => `#${t}`).join(' ')} (se crean al guardar).</span>}
      </div>

      <label className="grid gap-1">
        <span className="text-xs text-muted">Comercio</span>
        <input value={merchant} onChange={(e) => setMerchant(e.target.value)} list={`${id}-mer`} placeholder="Sin comercio" className="field" autoComplete="off" />
        <datalist id={`${id}-mer`}>{options.merchants.map((m) => <option key={m} value={m} />)}</datalist>
        {orNull(merchant) !== tx.merchant && <span className="text-xs text-muted">Solo este movimiento. Para que los próximos imports lo sigan, usá una regla.</span>}
      </label>

      <label className="grid gap-1">
        <span className="text-xs text-muted">Nota</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="field resize-y" />
      </label>

      <label className="grid gap-1">
        <span className="text-xs text-muted">Compromiso</span>
        <select value={commitment} onChange={(e) => setCommitment(e.target.value)} className="field">
          <option value="">Ninguno</option>
          {options.commitments.map((c) => <option key={c.id} value={c.id}>{c.description}</option>)}
        </select>
      </label>

      <label className="inline-flex items-start gap-2">
        <input type="checkbox" checked={oneOff} onChange={(e) => setOneOff(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
        <span>
          Puntual
          <span className="block text-xs text-muted">
            No entra en el promedio del pronóstico.{!tx.is_spending && ' (Este movimiento no cuenta como gasto.)'}
          </span>
        </span>
      </label>

      <div className="flex items-center gap-3 border-t border-line pt-4">
        <button disabled={!dirty || pending} className="rounded-lg bg-accent px-4 py-1.5 font-medium text-accent-ink disabled:opacity-50">
          {pending ? 'Guardando…' : 'Guardar'}
        </button>
        <span className="text-xs text-muted">{dirty ? '⌘/Ctrl + Enter' : 'Sin cambios'}</span>
      </div>
    </form>
  );
}
