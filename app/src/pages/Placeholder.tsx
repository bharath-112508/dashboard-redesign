import { Link } from 'react-router'

/** The DevOps board and Tickets pages aren't part of this build. */
export function Placeholder({ title }: { title: string }) {
  return (
    <main className="px-7 pb-14 pt-10">
      <div className="mx-auto max-w-[520px] rounded-2xl border-[1.5px] border-line-2 bg-white p-8 text-center">
        <div className="text-[20px] font-bold text-ink">{title}</div>
        <p className="mt-2 text-[14px] leading-[1.55] text-ink-2">
          This page isn't part of this build yet. Only the Clients page is implemented.
        </p>
        <Link to="/clients/board" className="mt-4 inline-flex h-9 items-center rounded-lg bg-blue px-4 text-[13.5px] font-semibold text-white no-underline hover:bg-blue-600">
          Go to Clients
        </Link>
      </div>
    </main>
  )
}
