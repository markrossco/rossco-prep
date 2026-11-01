import Link from 'next/link'
import { redirect } from 'next/navigation'
import Topbar from '@/components/topbar'
import ActionForm from '@/components/action-form'
import { requireSession } from '@/lib/session'
import { isOffice } from '@/lib/roles'
import { createItem } from '../actions'
import ItemFields from '../item-fields'

export default async function NewItemPage() {
  const { profile, supabase } = await requireSession()
  if (!isOffice(profile.role)) redirect('/equipment')
  const { data: cats } = await supabase
    .from('categories')
    .select('id, name, sort, department:departments(name, sort)')
    .is('archived_at', null)
    .order('sort')
  const categories = ((cats ?? []) as unknown as { id: string; name: string; department: { name: string; sort: number } | null }[])
    .sort((a, b) => (a.department?.sort ?? 99) - (b.department?.sort ?? 99))
    .map((c) => ({ id: c.id, label: `${c.department?.name ?? ''} / ${c.name}` }))
  const canSetQty = profile.role === 'admin' || profile.role === 'office_lead'

  return (
    <>
      <Topbar name={profile.full_name} role={profile.role} />
      <div className="shell">
        <h1>Add an item</h1>
        <p className="lead"><Link href="/equipment">Equipment register</Link></p>
        <div className="card" style={{ maxWidth: 640 }}>
          <ActionForm action={createItem} submit="Add item">
            <ItemFields v={{}} categories={categories} />
            {canSetQty ? (
              <>
                <label htmlFor="opening_qty">Quantity we own (stock items only)</label>
                <input id="opening_qty" name="opening_qty" inputMode="numeric" defaultValue="0" />
              </>
            ) : (
              <p className="muted">It starts with none owned. A lead or admin adds the quantity.</p>
            )}
          </ActionForm>
        </div>
      </div>
    </>
  )
}
