type Defaults = {
  ref?: string
  name?: string
  client_name?: string
  venue_name?: string
  out_date?: string
  return_date?: string
  status?: string
  notes?: string
}

/** The fields shared by the new-job form and the edit-job form. Names for the lists come from the page. */
export default function JobFields({
  d = {},
  clients,
  venues,
  withStatus,
  idPrefix,
}: {
  d?: Defaults
  clients: string[]
  venues: string[]
  withStatus?: boolean
  idPrefix: string
}) {
  const p = (s: string) => `${idPrefix}-${s}`
  return (
    <>
      <div className="row">
        <div>
          <label htmlFor={p('ref')}>Job reference (ROS number)</label>
          <input id={p('ref')} name="ref" defaultValue={d.ref} autoComplete="off" required />
        </div>
        <div>
          <label htmlFor={p('name')}>Job name</label>
          <input id={p('name')} name="name" defaultValue={d.name} autoComplete="off" required />
        </div>
      </div>
      <div className="row">
        <div>
          <label htmlFor={p('client')}>Client</label>
          <input id={p('client')} name="client_name" list={p('clients')} defaultValue={d.client_name} autoComplete="off" placeholder="Start typing the name" />
          <label className="check" htmlFor={p('newclient')}>
            <input id={p('newclient')} type="checkbox" name="new_client" /> Add as a new client if not in the list
          </label>
        </div>
        <div>
          <label htmlFor={p('venue')}>Venue</label>
          <input id={p('venue')} name="venue_name" list={p('venues')} defaultValue={d.venue_name} autoComplete="off" placeholder="Start typing the name" />
          <label className="check" htmlFor={p('newvenue')}>
            <input id={p('newvenue')} type="checkbox" name="new_venue" /> Add as a new venue if not in the list
          </label>
        </div>
      </div>
      <datalist id={p('clients')}>{clients.map((n) => <option key={n} value={n} />)}</datalist>
      <datalist id={p('venues')}>{venues.map((n) => <option key={n} value={n} />)}</datalist>
      <div className="row">
        <div>
          <label htmlFor={p('out')}>Out date</label>
          <input id={p('out')} type="date" name="out_date" defaultValue={d.out_date} required />
        </div>
        <div>
          <label htmlFor={p('back')}>Return date</label>
          <input id={p('back')} type="date" name="return_date" defaultValue={d.return_date} required />
        </div>
        {withStatus && (
          <div>
            <label htmlFor={p('status')}>Status</label>
            <select id={p('status')} name="status" defaultValue={d.status ?? 'provisional'}>
              <option value="provisional">Provisional</option>
              <option value="confirmed">Confirmed</option>
            </select>
          </div>
        )}
      </div>
      <label htmlFor={p('notes')}>Notes</label>
      <textarea id={p('notes')} name="notes" defaultValue={d.notes} />
    </>
  )
}
