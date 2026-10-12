import { Server } from 'lucide-react'
import type { OsKind } from '../../../shared/types'

/** /etc/os-release 的 ID → font-logos 图标后缀。不在表里的回退到系统级图标。 */
const DISTRO_ICON: Record<string, string> = {
  debian: 'debian',
  ubuntu: 'ubuntu',
  kubuntu: 'kubuntu',
  linuxmint: 'linuxmint',
  pop: 'pop-os',
  zorin: 'zorin',
  elementary: 'elementary',
  deepin: 'deepin',
  kali: 'kali-linux',
  parrot: 'parrot',
  mxlinux: 'mxlinux',
  raspbian: 'raspberry-pi',
  fedora: 'fedora',
  centos: 'centos',
  rhel: 'redhat',
  redhat: 'redhat',
  rocky: 'rocky-linux',
  almalinux: 'almalinux',
  opensuse: 'opensuse',
  'opensuse-tumbleweed': 'tumbleweed',
  sles: 'opensuse',
  mageia: 'mageia',
  mandriva: 'mandriva',
  nobara: 'nobara',
  arch: 'archlinux',
  archlinux: 'archlinux',
  manjaro: 'manjaro',
  endeavouros: 'endeavour',
  garuda: 'garuda',
  artix: 'artix',
  alpine: 'alpine',
  nixos: 'nixos',
  gentoo: 'gentoo',
  slackware: 'slackware',
  void: 'void',
  solus: 'solus',
  devuan: 'devuan',
  coreos: 'coreos',
  freebsd: 'freebsd',
  openbsd: 'openbsd'
}

/** 系统/发行版图标。优先发行版（font-logos 字体图标），退到系统级，认不出用服务器。 */
export function OsIcon(props: { os?: OsKind; distro?: string }) {
  const suffix = props.distro ? DISTRO_ICON[props.distro] : undefined
  if (suffix) return <i className={`fl fl-${suffix} inline-block w-4 shrink-0 text-center text-[15px] leading-none`} />
  if (props.os === 'linux') return <i className="fl fl-tux inline-block w-4 shrink-0 text-center text-[15px] leading-none" />
  if (props.os === 'macos') return <i className="fl fl-apple inline-block w-4 shrink-0 text-center text-[15px] leading-none" />
  if (props.os === 'windows') {
    return (
      <svg viewBox="0 0 16 16" className="size-4 shrink-0" fill="currentColor">
        <rect x="2" y="2" width="5.5" height="5.5" rx="0.5" />
        <rect x="8.5" y="2" width="5.5" height="5.5" rx="0.5" />
        <rect x="2" y="8.5" width="5.5" height="5.5" rx="0.5" />
        <rect x="8.5" y="8.5" width="5.5" height="5.5" rx="0.5" />
      </svg>
    )
  }
  return <Server className="size-4 shrink-0" strokeWidth={2} />
}

/** SessionConfig.os 里存的可能是发行版 id 也可能是系统名，拆开喂给 OsIcon。 */
export function osIconProps(saved?: string): { os?: OsKind; distro?: string } {
  if (!saved) return {}
  if (saved === 'windows' || saved === 'linux' || saved === 'macos' || saved === 'unknown') {
    return { os: saved }
  }
  return { os: 'linux', distro: saved }
}
