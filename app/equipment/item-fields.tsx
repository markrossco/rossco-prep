type Cat = { id: string; label: string }

export type ItemValues = {
  name?: string
  kind?: string
  category_id?: string | null
  tags?: string[]
  can_sub_hire?: boolean
  active?: boolean
  accessory_only?: boolean
  barcode?: string | null
  weight_kg?: number | null
  description?: string | null
  notes?: string | null
}

/** The fields shared by "Add an item" and "Edit item". */
export default function ItemFields({
  v,
  categories,
  editing,
}: {
  v: ItemValues
  categories: Cat[]
  editing?: boolean
}) {
  return (
    <>
      <label htmlFor="name">Name</label>
      <input id="name" name="name" required defaultValue={v.name ?? ''} />
      <div className="row">
        <div>
          <label htmlFor="kind">Kind</label>
          <select id="kind" name="kind" defaultValue={v.kind ?? 'stock'}>
            <option value="stock">Stock (counted, can be short)</option>
            <option value="kit">Kit or package (title only, holds no stock)</option>
            <option value="consumable">Consumable (never short)</option>
          </select>
        </div>
        <div>
          <label htmlFor="category_id">Category</label>
          <select id="category_id" name="category_id" defaultValue={v.category_id ?? ''}>
            <option value="">No category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>
      </div>
      <label htmlFor="tags">Tags (separate with commas)</label>
      <input id="tags" name="tags" defaultValue={(v.tags ?? []).join(', ')} />
      <div className="row">
        <div>
          <label htmlFor="barcode">Barcode</label>
          <input id="barcode" name="barcode" defaultValue={v.barcode ?? ''} />
        </div>
        {editing && (
          <div>
            <label htmlFor="weight_kg">Weight (kg)</label>
            <input id="weight_kg" name="weight_kg" inputMode="decimal" defaultValue={v.weight_kg ?? ''} />
          </div>
        )}
      </div>
      <label htmlFor="description">Description</label>
      <textarea id="description" name="description" defaultValue={v.description ?? ''} />
      {editing && (
        <>
          <label htmlFor="notes">Internal notes</label>
          <textarea id="notes" name="notes" defaultValue={v.notes ?? ''} />
        </>
      )}
      <label className="check" htmlFor="can_sub_hire">
        <input id="can_sub_hire" type="checkbox" name="can_sub_hire" defaultChecked={v.can_sub_hire ?? true} />
        Can be sub-hired when we run short
      </label>
      {editing && (
        <>
          <label className="check" htmlFor="active">
            <input id="active" type="checkbox" name="active" defaultChecked={v.active ?? true} />
            Active (untick to stop it going on new jobs)
          </label>
          <label className="check" htmlFor="accessory_only">
            <input id="accessory_only" type="checkbox" name="accessory_only" defaultChecked={v.accessory_only ?? false} />
            Accessory only (only offered with the item it belongs to)
          </label>
        </>
      )}
    </>
  )
}
