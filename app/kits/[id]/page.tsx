import Link from 'next/link'
import { notFound } from 'next/navigation'
import Topbar from '@/components/topbar'
import ActionForm from '@/components/action-form'
import { requireSession } from '@/lib/session'
import { isUuid } from '@/lib/db'
import { addContent, removeContent, updateContent } from '../actions'

type Content = {
  id: string
  inclusion: string
  qty_per_parent: number
  child: { id: string; name: string; kind: string; active: boolean }
}

export default async function KitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  const { profile, supabase } = await requireSession()
  const canEdit = profile.role === 'admin' || profile.role === 'office_lead'

  const { data: parent } = await supabase.from('equipment_types').select('id, name, kind').eq('id', id).maybeSingle()
  if (!parent) notFound()

  const [{ data: contents }, { data: names }] = await Promise.all([
    supabase
      .from('type_accessories')
      .select('id, inclusion, qty_per_parent, child:equipment_types!child_type_id(id, name, kind, active)')
      .eq('parent_type_id', id)
      .is('archived_at', null)
      .order('sort')
      .order('created_at'),
    canEdit
      ? supabase.from('equipment_types').select('name').neq('kind', 'kit').eq('active', true).is('archived_at', null).neq('id', id).order('name').limit(3000)
      : Promise.resolve({ data: [] as { name: string }[] }),
  ])
  const rows = (contents ?? []) as unknown as Content[]

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>{parent.name}</h1>
        <p className="lead">
          <Link href="/kits">Kits and packages</Link> · <Link href={`/equipment/${id}`}>Item page</Link>
        </p>
        {parent.kind === 'consumable' && <p className="error">A consumable cannot have contents.</p>}

        <div className="card table-wrap">
          <table>
            <thead><tr><th>Item</th><th>When a job adds this</th><th className="num">Qty each</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/equipment/${r.child.id}`}>{r.child.name}</Link>
                    {r.child.kind === 'consumable' && <span className="badge">consumable</span>}
                    {!r.child.active && <span className="badge">off</span>}
                  </td>
                  {canEdit ? (
                    <td colSpan={3}>
                      <ActionForm action={updateContent} submit="Save" small inline>
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="parent_type_id" value={id} />
                        <select name="inclusion" defaultValue={r.inclusion} aria-label="Inclusion">
                          <option value="mandatory">Always included, cannot be removed</option>
                          <option value="default">Included, can be removed</option>
                          <option value="optional">Offered, not included</option>
                        </select>
                        <input name="qty_per_parent" inputMode="numeric" defaultValue={r.qty_per_parent} aria-label="Quantity each" style={{ width: 70 }} />
                      </ActionForm>
                      <ActionForm action={removeContent} submit="Remove" small secondary inline>
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="parent_type_id" value={id} />
                      </ActionForm>
                    </td>
                  ) : (
                    <>
                      <td>{r.inclusion === 'mandatory' ? 'Always included' : r.inclusion === 'default' ? 'Included' : 'Offered'}</td>
                      <td className="num">{r.qty_per_parent}</td>
                      <td></td>
                    </>
                  )}
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={4} className="muted">Nothing listed yet.</td></tr>}
            </tbody>
          </table>
        </div>

        {canEdit && parent.kind !== 'consumable' && (
          <section className="card" style={{ marginTop: 20, maxWidth: 640 }}>
            <h2 style={{ marginTop: 0 }}>Add to the contents</h2>
            <ActionForm action={addContent} submit="Add" clearOnSuccess>
              <input type="hidden" name="parent_type_id" value={id} />
              <label htmlFor="item_name">Item</label>
              <input id="item_name" name="item_name" list="content-names" autoComplete="off" placeholder="Start typing the name" />
              <datalist id="content-names">
                {(names ?? []).map((n) => (
                  <option key={n.name} value={n.name} />
                ))}
              </datalist>
              <div className="row">
                <div>
                  <label htmlFor="inclusion">When a job adds this</label>
                  <select id="inclusion" name="inclusion" defaultValue="default">
                    <option value="mandatory">Always included, cannot be removed</option>
                    <option value="default">Included, can be removed</option>
                    <option value="optional">Offered, not included</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="qty_per_parent">Quantity each</label>
                  <input id="qty_per_parent" name="qty_per_parent" inputMode="numeric" defaultValue="1" />
                </div>
              </div>
            </ActionForm>
          </section>
        )}
        {!canEdit && <p className="muted" style={{ marginTop: 16 }}>Only an admin or office lead edits kit contents.</p>}
      </div>
    </>
  )
}
