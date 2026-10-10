/** Stands in for a page this build does not have yet. Its package drops the real page into the same route. */
export function ComingSoon({ page }: { page: string }) {
  return (
    <main className="px-7 pb-14 pt-10">
      <div className="mx-auto max-w-[520px] rounded-2xl border-[1.5px] border-line-2 bg-white p-8 text-center">
        <div className="text-[20px] font-bold text-ink">{page}</div>
        <p className="mt-2 text-[14px] leading-[1.55] text-ink-2">This page is coming in this build.</p>
      </div>
    </main>
  )
}
