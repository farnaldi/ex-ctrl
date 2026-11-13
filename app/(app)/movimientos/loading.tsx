/** Shown instantly while /movimientos renders (navigation and filter changes), so a click always gives feedback. */
export default function Loading() {
  const widths = ['w-2/3', 'w-1/2', 'w-3/4', 'w-2/5', 'w-3/5'];
  return (
    <div aria-busy="true" aria-label="Cargando movimientos" className="animate-pulse">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <div className="h-7 w-44 rounded bg-line" />
          <div className="mt-2 h-4 w-28 rounded bg-line" />
        </div>
        <div className="h-8 w-40 rounded-lg bg-line" />
      </div>
      <div className="mb-4 h-[116px] rounded-xl border border-line bg-surface" />
      <div className="mb-4 h-4 w-80 rounded bg-line" />
      <div className="rounded-xl border border-line bg-surface">
        <div className="h-9 border-b border-line" />
        <ul className="divide-y divide-line">
          {Array.from({ length: 12 }, (_, i) => (
            <li key={i} className="flex items-center gap-4 px-4 py-3.5">
              <div className="h-4 w-12 shrink-0 rounded bg-line" />
              <div className={`h-4 ${widths[i % widths.length]} rounded bg-line`} />
              <div className="ml-auto h-4 w-20 shrink-0 rounded bg-line" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
