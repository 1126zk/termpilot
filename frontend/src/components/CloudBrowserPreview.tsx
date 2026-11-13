import { ArrowLeft, ArrowRight, Check, ChevronDown, Globe, LockKeyhole, RotateCw, X } from 'lucide-react'
import { useAppStore } from '../stores/useAppStore'

const browserButton =
  'flex size-7 shrink-0 items-center justify-center rounded-md text-[#5f6368] transition-colors hover:bg-black/5 hover:text-[#202124] disabled:opacity-40'

export function CloudBrowserPreview(props: { termId: string }) {
  const toggleBrowserPreview = useAppStore((s) => s.toggleBrowserPreview)

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-border bg-[#e9eaee] text-[#202124]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-black/10 bg-[#dfe1e5] px-2.5">
        <Globe className="size-4 text-[#5f6368]" />
        <span className="text-xs font-semibold text-[#3c4043]">云浏览器</span>
        <span className="rounded bg-black/6 px-1.5 py-0.5 text-[10px] text-[#5f6368]">静态预览</span>
        <div className="flex-1" />
        <button type="button" className={browserButton} title="关闭云浏览器" onClick={() => toggleBrowserPreview(props.termId)}>
          <X className="size-3.5" />
        </button>
      </div>

      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-black/8 bg-[#f1f3f4] px-2">
        <button type="button" className={browserButton} title="后退" disabled>
          <ArrowLeft className="size-4" />
        </button>
        <button type="button" className={browserButton} title="前进" disabled>
          <ArrowRight className="size-4" />
        </button>
        <button type="button" className={browserButton} title="刷新" disabled>
          <RotateCw className="size-3.5" />
        </button>
        <div className="mx-1 flex h-7 min-w-0 flex-1 items-center gap-2 rounded-full bg-white px-3 text-xs text-[#5f6368] shadow-sm">
          <LockKeyhole className="size-3 shrink-0" />
          <span className="truncate">http://127.0.0.1:3000</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-[#f6f8fb] select-text">
        <header className="flex h-14 items-center border-b border-[#e7eaf0] bg-white px-5">
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-[#4f6bed] text-white">
              <Globe className="size-4" />
            </span>
            <span className="text-sm font-semibold">Web App</span>
          </div>
          <nav className="ml-8 flex items-center gap-5 text-xs text-[#697386]">
            <span className="font-semibold text-[#4f6bed]">Overview</span>
            <span>Deployments</span>
            <span>Activity</span>
          </nav>
          <div className="flex-1" />
          <span className="flex size-7 items-center justify-center rounded-full bg-[#e8edff] text-xs font-semibold text-[#4f6bed]">D</span>
        </header>

        <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-5">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-medium text-[#8a94a6]">WORKSPACE / DEVELOPMENT</p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight text-[#172033]">Project overview</h1>
            </div>
            <button type="button" className="flex h-8 items-center gap-2 rounded-md bg-[#4f6bed] px-3 text-xs font-medium text-white shadow-sm">
              New deployment
              <ChevronDown className="size-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Metric label="Service status" value="Running" detail="Healthy" accent />
            <Metric label="Local port" value="3000" detail="TCP" />
            <Metric label="Environment" value="Development" detail="Node.js" />
          </div>

          <section className="overflow-hidden rounded-lg border border-[#e4e8f0] bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-[#edf0f5] px-4 py-3">
              <h2 className="text-sm font-semibold text-[#253047]">Recent deployments</h2>
              <span className="text-[11px] text-[#8a94a6]">Last 24 hours</span>
            </div>
            <Deployment name="Update dashboard layout" hash="8f2c7a1" time="2 minutes ago" />
            <Deployment name="Add development API routes" hash="31bd94e" time="18 minutes ago" />
            <Deployment name="Initial project setup" hash="c70a412" time="1 hour ago" />
          </section>
        </main>
      </div>
    </section>
  )
}

function Metric(props: { label: string; value: string; detail: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-[#e4e8f0] bg-white p-3 shadow-sm">
      <p className="text-[11px] text-[#8a94a6]">{props.label}</p>
      <div className="mt-2 flex items-center gap-1.5">
        {props.accent && <span className="size-2 rounded-full bg-[#34a853]" />}
        <span className="truncate text-sm font-semibold text-[#253047]">{props.value}</span>
      </div>
      <p className="mt-1 text-[11px] text-[#8a94a6]">{props.detail}</p>
    </div>
  )
}

function Deployment(props: { name: string; hash: string; time: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-[#edf0f5] px-4 py-3 last:border-b-0">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[#eaf7ee] text-[#2f924a]">
        <Check className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-[#253047]">{props.name}</p>
        <p className="mt-0.5 font-mono text-[10px] text-[#8a94a6]">{props.hash}</p>
      </div>
      <span className="shrink-0 text-[10px] text-[#8a94a6]">{props.time}</span>
    </div>
  )
}
