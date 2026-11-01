export type Role = 'admin' | 'office_lead' | 'office' | 'warehouse_lead' | 'warehouse'

export const ROLES: { value: Role; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'office_lead', label: 'Office lead' },
  { value: 'office', label: 'Office' },
  { value: 'warehouse_lead', label: 'Warehouse lead' },
  { value: 'warehouse', label: 'Warehouse' },
]

export const roleLabel = (r: string) => ROLES.find((x) => x.value === r)?.label ?? r

export const isOffice = (r: Role) => r === 'admin' || r === 'office_lead' || r === 'office'
export const isWarehouse = (r: Role) => r === 'warehouse_lead' || r === 'warehouse'
