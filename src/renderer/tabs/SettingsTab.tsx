import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { KineticTitle } from '../components/KineticTitle';
import { RECOMMENDED_MODEL_ID, type ModelList, type ModelOption } from '@shared/models';
import type { ProtonReleaseList, Settings, SoundGroup, SoundGroups, Source } from '@shared/types';
import { formatBytes } from '@shared/format';
import { api } from '../api';
import { attempt, pushToast, useApp } from '../state';
import { Button, IconButton } from '../components/ui';
import { ConsentDialog } from '../components/ConsentDialog';
import { Icon, type IconName } from '../components/Icon';
import { sound, type SoundName } from '../sound';
import { useMotionPrefs } from '../hooks/useMotion';

type SectionId = 'sources' | 'ai' | 'compat' | 'downloads' | 'content' | 'appearance' | 'sound' | 'privacy' | 'about';

interface SectionDef { id: SectionId; label: string; icon: IconName; blurb: string; keywords: string }

const SECTIONS: SectionDef[] = [
  { id: 'sources', label: 'Websites & indexing', icon: 'globe', blurb: 'Sites the AI indexes, and how often', keywords: 'websites sources add site rescan pages batch request gap rate limit refresh re-check interval indexing crawl learned layout' },
  { id: 'ai', label: 'Local AI', icon: 'cpu', blurb: 'Model, GPU and performance', keywords: 'ai model fara download gpu vulkan cpu threads context unload memory vram acceleration legacy holo qwen' },
  { id: 'compat', label: 'Windows games', icon: 'wine', blurb: 'Proton, Wine and umu', keywords: 'windows proton ge cachyos valve wine umu compatibility runtime python' },
  { id: 'downloads', label: 'Downloads & updates', icon: 'downloads', blurb: 'Game updates, speed and folders', keywords: 'downloads connections parallel simultaneous folders games library storage path disk updates update automatic new version patch rollback saves' },
  { id: 'content', label: 'Content', icon: 'shield', blurb: 'Adult-content visibility', keywords: 'nsfw adult content consent classifier safe mature' },
  { id: 'appearance', label: 'Appearance', icon: 'palette', blurb: 'Effects and motion', keywords: 'appearance effects motion animation reduced low 3d visuals' },
  { id: 'sound', label: 'Sound', icon: 'volume', blurb: 'Interface sounds and ambience', keywords: 'sound audio volume hover click navigation ambient soundscape music mute alerts downloads' },
  { id: 'privacy', label: 'Privacy & data', icon: 'lock', blurb: 'Tracking and stored data', keywords: 'privacy tracking do not track cookies clear cache browser data forget catalog' },
  { id: 'about', label: 'About', icon: 'info', blurb: 'Version, logs and licences', keywords: 'about version license logs folder keyboard shortcuts components' },
];

function update(patch: Partial<Settings>) {
  return attempt(() => api.invoke('settings:update', patch as never));
}

/* ------------------------------------------------------------------ layout */

export function SettingsTab() {
  const settings = useApp((s) => s.settings);
  const [section, setSection] = useState<SectionId>('sources');
  const [query, setQuery] = useState('');
  const { reduced } = useMotionPrefs();
  const status = useSectionStatus(settings);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS.filter((s) => `${s.label} ${s.blurb} ${s.keywords}`.toLowerCase().includes(q));
  }, [query]);
  // Searching jumps to the first matching section.
  useEffect(() => {
    if (visible.length && !visible.some((s) => s.id === section)) setSection(visible[0].id);
  }, [visible, section]);
  if (!settings) return null;
  const current = SECTIONS.find((s) => s.id === section)!;
  return (
    <div className="page page--settings">
      <div className="page__scroll">
        <header className="page__header">
          <div className="page__titles">
            <p className="eyebrow">Control</p>
            <KineticTitle text="Settings" />
          </div>
        </header>
        <div className="st">
          <nav className="st__nav" aria-label="Settings sections">
            <label className="st__search">
              <Icon name="search" size={16} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search settings" aria-label="Search settings" />
              {query && <button className="st__search-clear" onClick={() => setQuery('')} aria-label="Clear search"><Icon name="close" size={14} /></button>}
            </label>
            <ul role="tablist" aria-orientation="vertical">
              {visible.map((s, i) => (
                <li key={s.id}>
                  <button
                    role="tab"
                    id={`settings-tab-${s.id}`}
                    aria-selected={section === s.id}
                    aria-controls="settings-panel"
                    tabIndex={section === s.id ? 0 : -1}
                    className={`st__tab ${section === s.id ? 'is-on' : ''}`}
                    onClick={() => setSection(s.id)}
                    onKeyDown={(e) => {
                      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                      e.preventDefault();
                      const next = visible[(i + (e.key === 'ArrowDown' ? 1 : visible.length - 1)) % visible.length];
                      setSection(next.id);
                      document.getElementById(`settings-tab-${next.id}`)?.focus();
                    }}
                  >
                    {section === s.id && <motion.span layoutId="st-tab-glow" className="st__tab-glow" transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 36 }} />}
                    <span className="st__tab-icon"><Icon name={s.icon} size={18} /></span>
                    <span className="st__tab-text">
                      <span className="st__tab-label">{s.label}</span>
                      <span className="st__tab-status">{status[s.id] ?? s.blurb}</span>
                    </span>
                  </button>
                </li>
              ))}
              {!visible.length && <li className="st__empty">No settings match “{query}”.</li>}
            </ul>
          </nav>
          <div className="st__panel" role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${section}`}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={section}
                initial={reduced ? false : { opacity: 0, x: 18, filter: 'blur(6px)' }}
                animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, x: -12, filter: 'blur(4px)' }}
                transition={{ duration: reduced ? 0 : 0.28, ease: [0.16, 1, 0.3, 1] }}
              >
                <header className="st__head">
                  <span className="st__head-icon"><Icon name={current.icon} size={26} /></span>
                  <div>
                    <h2>{current.label}</h2>
                    <p>{current.blurb}</p>
                  </div>
                </header>
                {section === 'sources' && <SourcesSection settings={settings} />}
                {section === 'ai' && <AiSection settings={settings} />}
                {section === 'compat' && <CompatSection settings={settings} />}
                {section === 'downloads' && <DownloadSection settings={settings} />}
                {section === 'content' && <ContentSection settings={settings} />}
                {section === 'appearance' && <AppearanceSection settings={settings} />}
                {section === 'sound' && <SoundSection settings={settings} />}
                {section === 'privacy' && <PrivacySection settings={settings} />}
                {section === 'about' && <AboutSection />}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One-line live status under each section name. */
function useSectionStatus(settings: Settings | null): Partial<Record<SectionId, string>> {
  const sources = useApp((s) => s.sources);
  const info = useApp((s) => s.info);
  const ai = useApp((s) => s.ai);
  const models = useModels();
  if (!settings) return {};
  const fara = models?.models.find((m) => m.id === RECOMMENDED_MODEL_ID);
  const games = sources.reduce((n, s) => n + s.entryCount, 0);
  return {
    sources: sources.length ? `${sources.length} site${sources.length === 1 ? '' : 's'} · ${games} games` : 'No websites yet',
    ai: fara?.installed ? `${fara.name} · ${ai.modelLoaded ? 'loaded' : 'ready'}${ai.accel ? ` · ${ai.accel === 'vulkan' ? 'GPU' : 'CPU'}` : ''}` : fara ? 'Download required' : undefined,
    compat: settings.protonPath ? `${settings.protonPath.split('/').pop()?.replace(/^ge-/, '')} active` : 'Installs on first use',
    downloads: `${settings.downloadConnections} connections · ${settings.maxConcurrentDownloads} at once`,
    content: settings.showNsfw ? 'Adult content shown' : 'Adult content hidden',
    appearance: `${settings.effects === 'full' ? 'Full effects' : 'Low effects'} · motion ${settings.motion}`,
    sound: settings.uiSounds ? `On · ${Math.round(settings.uiVolume * 100)}%${settings.uiAmbient ? ' · ambience' : ''}` : 'Off',
    privacy: settings.sendDoNotTrack ? 'Do Not Track on' : 'Do Not Track off',
    about: info ? `Version ${info.appVersion}` : undefined,
  };
}

function useModels() {
  const [models, setModels] = useState<ModelList | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => { void api.invoke('models:list').then((r) => { if (live) setModels(r); }).catch(() => undefined); };
    load();
    const off = api.on('models:changed', (r) => { if (live) setModels(r); });
    const timer = setInterval(load, 2000);
    return () => { live = false; off(); clearInterval(timer); };
  }, []);
  return models;
}

/* ------------------------------------------------------------- primitives */

function Group({ title, children, aside }: { title?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="st-group">
      {(title || aside) && <header className="st-group__head">{title && <h3>{title}</h3>}{aside}</header>}
      <div className="st-group__body">{children}</div>
    </section>
  );
}

/** A setting: label and explanation on the left, its control on the right. */
function Row({ label, desc, children, stacked }: { label: ReactNode; desc?: ReactNode; children?: ReactNode; stacked?: boolean }) {
  return (
    <div className={`st-row ${stacked ? 'st-row--stacked' : ''}`}>
      <div className="st-row__text">
        <span className="st-row__label">{label}</span>
        {desc && <span className="st-row__desc">{desc}</span>}
      </div>
      {children && <div className="st-row__control">{children}</div>}
    </div>
  );
}

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="switch__thumb" />
    </button>
  );
}

function Range({ value, min, max, step = 1, unit, onCommit, label, format }: { value: number; min: number; max: number; step?: number; unit?: string; onCommit: (v: number) => void; label: string; format?: (v: number) => string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => { if (v !== value) onCommit(v); };
  return (
    <div className="st-range">
      <input
        type="range" min={min} max={max} step={step} value={v} aria-label={label}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={commit} onKeyUp={commit} onBlur={commit}
        style={{ ['--fill' as string]: `${((v - min) / (max - min)) * 100}%` }}
      />
      <output className="st-range__value mono">{format ? format(v) : `${v}${unit ? ` ${unit}` : ''}`}</output>
    </div>
  );
}

function Choice<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? 'is-on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function StatusCard({ icon, tone, title, detail, children }: { icon: IconName; tone: 'ok' | 'busy' | 'warn' | 'off'; title: ReactNode; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`st-status st-status--${tone}`}>
      <span className="st-status__icon"><Icon name={icon} size={26} /></span>
      <div className="st-status__text">
        <strong>{title}</strong>
        {detail && <span>{detail}</span>}
      </div>
      {children && <div className="st-status__actions">{children}</div>}
    </div>
  );
}

/* --------------------------------------------------------------- sections */

const STATUS_TEXT: Record<Source['status'], string> = {
  idle: 'Waiting', crawling: 'Indexing', ok: 'Up to date', blocked: 'Needs a check', unsupported: 'No games found', error: 'Error',
};

function SourcesSection({ settings }: { settings: Settings }) {
  const sources = useApp((s) => s.sources);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const add = async () => {
    let u = url.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    const r = await attempt(() => api.invoke('sources:add', { url: u, name: name.trim() || undefined }));
    if (r) { setUrl(''); setName(''); pushToast('success', `Added ${r.name}. The AI learns its layout the next time the Store is open.`); }
  };
  return (
    <>
      <Group title="Add a website">
        <form className="st-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <input className="input" placeholder="https://site.example/games" value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" aria-label="Website address" />
          <input className="input" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Website name" />
          <Button variant="primary" icon="plus" type="submit" disabled={!url.trim()}>Add</Button>
        </form>
        <p className="st-note">Use a page that lists games (“browse”, “new releases”). The local AI learns each site’s layout once, then indexes it quickly; pages that need a person’s check are skipped and retried.</p>
      </Group>
      {sources.length > 0 && (
        <Group title="Your websites">
          <ul className="st-sources">{sources.map((s) => <SourceCard key={s.id} s={s} />)}</ul>
        </Group>
      )}
      <Group title="Indexing">
        <Row label="Check for new games every" desc="Indexed sites are re-checked while the Store is open. Re-checks stop as soon as listings show nothing new; a full walk runs weekly.">
          <Choice label="Re-check interval" value={String(settings.crawlRefreshHours)} options={[1, 3, 6, 12, 24].map((h) => ({ value: String(h), label: `${h} h` }))} onChange={(v) => void update({ crawlRefreshHours: Number(v) })} />
        </Row>
      </Group>
    </>
  );
}

function SourceCard({ s }: { s: Source }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`st-source st-source--${s.status} ${s.enabled ? '' : 'is-off'}`}>
      <div className="st-source__main">
        <span className={`st-source__dot st-source__dot--${s.status}`} aria-hidden="true" />
        <div className="st-source__text">
          <p className="st-source__name">{s.name}</p>
          <p className="st-source__url mono">{s.url}</p>
          <div className="st-source__chips">
            <span className="st-chip">{STATUS_TEXT[s.status]}</span>
            <span className="st-chip">{s.entryCount} games</span>
            {s.learned && <span className="st-chip st-chip--ai" title={`Layout learned ${new Date(s.learned.at).toLocaleString()}`}>AI learned layout{s.learned.browser ? ' · via Firefox' : ''}</span>}
            {s.lastCrawlAt && <span className="st-chip st-chip--muted">checked {new Date(s.lastCrawlAt).toLocaleString()}</span>}
          </div>
          {s.statusDetail && <p className="st-source__detail">{s.statusDetail}</p>}
        </div>
        <div className="st-source__actions">
          <Switch checked={s.enabled} label={`${s.enabled ? 'Disable' : 'Enable'} ${s.name}`} onChange={(v) => void attempt(() => api.invoke('sources:update', { id: s.id, enabled: v }))} />
          <IconButton icon="reload" label={`Check ${s.name} for new games now`} onClick={() => void attempt(() => api.invoke('sources:recrawl', { id: s.id }), 'Queued — it runs while the Store is open.')} />
          <IconButton icon="sliders" label={`Options for ${s.name}`} aria-expanded={open} onClick={() => setOpen(!open)} />
          <IconButton icon="trash" label={`Remove ${s.name}`} onClick={() => void attempt(() => api.invoke('sources:remove', { id: s.id }))} />
        </div>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="st-source__options" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25 }}>
            <Row label="Listing pages per batch" desc="Each batch is checkpointed; indexing continues with the next batch while the Store stays open.">
              <Range label="Pages per batch" value={s.maxPages} min={1} max={50} onCommit={(v) => void attempt(() => api.invoke('sources:update', { id: s.id, maxPages: v }))} />
            </Row>
            <Row label="Minimum gap between requests" desc="Politeness floor. It slows down further by itself when the site asks (HTTP 429).">
              <Range label="Request gap" value={s.rateLimitMs} min={100} max={5000} step={100} unit="ms" onCommit={(v) => void attempt(() => api.invoke('sources:update', { id: s.id, rateLimitMs: v }))} />
            </Row>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

function AiSection({ settings }: { settings: Settings }) {
  const info = useApp((s) => s.info);
  const ai = useApp((s) => s.ai);
  const models = useModels();
  const [busy, setBusy] = useState(false);
  const cores = info?.cpuCount ?? 8;
  const fara = models?.models.find((m) => m.id === RECOMMENDED_MODEL_ID);
  const singleModel = models?.agents.every((a) => a.modelId === RECOMMENDED_MODEL_ID) ?? true;
  const progress = (m: ModelOption) => {
    const total = m.downloads.reduce((n, d) => n + d.totalBytes, 0);
    const got = m.downloads.reduce((n, d) => n + (d.state === 'installed' ? d.totalBytes : d.receivedBytes), 0);
    return total ? got / total : 0;
  };
  const act = (fn: () => Promise<ModelList>) => { setBusy(true); void attempt(fn).finally(() => setBusy(false)); };
  const downloading = (m: ModelOption) => m.downloads.some((d) => ['active', 'queued', 'verifying'].includes(d.state));
  return (
    <>
      {fara && (
        <StatusCard
          icon="cpu"
          tone={fara.installed ? (ai.modelLoaded ? 'ok' : 'off') : downloading(fara) ? 'busy' : 'warn'}
          title={<>{fara.name} <span className="muted">· {fara.quantization} · {formatBytes(fara.bytes)}</span></>}
          detail={fara.installed
            ? `${ai.modelLoaded ? 'Loaded' : 'Installed — loads when the Store opens'}${ai.accel ? ` on the ${ai.accel === 'vulkan' ? 'GPU (Vulkan)' : 'CPU'}` : ''}. One model handles browsing, page analysis and choosing game executables.`
            : downloading(fara) ? `Downloading… ${Math.round(progress(fara) * 100)}% (pause or resume in Downloads)` : 'Microsoft’s computer-use model. Download it once; it stays outside the AppImage and is SHA-256 verified.'}
        >
          {!fara.installed && <Button variant="primary" icon="downloads" disabled={busy || downloading(fara)} onClick={() => act(() => api.invoke('models:download', { id: fara.id }))}>{downloading(fara) ? 'Downloading…' : 'Download'}</Button>}
          {fara.installed && !singleModel && <Button variant="primary" disabled={busy} onClick={() => act(() => api.invoke('models:assignAll', { id: fara.id }))}>Use for everything</Button>}
        </StatusCard>
      )}
      {fara && !fara.installed && downloading(fara) && <div className="st-progress"><span style={{ width: `${progress(fara) * 100}%` }} /></div>}

      <Group title="Performance">
        <Row label="Acceleration" desc={info?.vulkanAvailable ? 'Vulkan was found. Automatic uses the GPU and falls back to the CPU if it cannot start.' : 'No Vulkan loader found, so the CPU build is used.'}>
          <Choice label="Acceleration" value={settings.aiAcceleration} options={[{ value: 'auto', label: 'Automatic' }, { value: 'vulkan', label: 'GPU' }, { value: 'cpu', label: 'CPU' }]} onChange={(v) => void update({ aiAcceleration: v })} />
        </Row>
        <Row label="CPU threads" desc={`Of ${cores}. Used for parts that run on the CPU; fewer keeps games and the desktop responsive.`}>
          <Range label="CPU threads" value={settings.aiThreads} min={1} max={Math.max(2, cores)} onCommit={(v) => void update({ aiThreads: v })} />
        </Row>
        <Row label="Free the GPU when idle after" desc="Unloads the model when the AI has nothing to do, so games get all of the video memory. It reloads in a few seconds when needed.">
          <Range label="Unload when idle" value={settings.aiIdleUnloadMinutes} min={0} max={60} unit="min" format={(v) => (v === 0 ? 'Never' : `${v} min`)} onCommit={(v) => void update({ aiIdleUnloadMinutes: v })} />
        </Row>
      </Group>

      <details className="st-advanced">
        <summary><Icon name="sliders" size={16} /> Advanced</summary>
        <Group>
          <Row label="Context size" desc="How much the model can keep in mind at once. 16K holds three screenshots plus the conversation; 32K uses more memory.">
            <Choice label="Context size" value={String(Math.max(16384, settings.aiContextSize))} options={[{ value: '16384', label: '16K' }, { value: '32768', label: '32K' }]} onChange={(v) => void update({ aiContextSize: Number(v) })} />
          </Row>
          <Row label="Other models" desc="Older specialist models stay available for existing installations. The recommended setup uses one model for every role." stacked>
            <ul className="st-models">
              {models?.models.filter((m) => m.id !== RECOMMENDED_MODEL_ID).map((m) => {
                const roles = models.agents.filter((a) => a.modelId === m.id).map((a) => a.role);
                return (
                  <li key={m.id}>
                    <span><strong>{m.name}</strong> <span className="muted">{m.quantization} · {formatBytes(m.bytes)}{m.installed ? ' · installed' : ''}{roles.length ? ` · used for ${roles.join(', ')}` : ''}</span></span>
                    {!m.installed && <Button size="sm" variant="ghost" disabled={busy || downloading(m)} onClick={() => act(() => api.invoke('models:download', { id: m.id }))}>{downloading(m) ? `${Math.round(progress(m) * 100)}%` : 'Download'}</Button>}
                  </li>
                );
              })}
            </ul>
          </Row>
        </Group>
      </details>
      <p className="st-note">The AI only works while the Store is open. Downloads keep going when you leave; games never start by themselves.</p>
    </>
  );
}

function CompatSection({ settings }: { settings: Settings }) {
  const info = useApp((s) => s.info);
  const [compat, setCompat] = useState<{ protonPath: string | null; provisioning: boolean; python3: boolean } | null>(null);
  const [releases, setReleases] = useState<ProtonReleaseList | null>(null);
  const [provider, setProvider] = useState('ge');
  const [releaseId, setReleaseId] = useState('');
  const [busy, setBusy] = useState(false);
  const [wine, setWine] = useState(settings.winePath);
  const [umu, setUmu] = useState(settings.umuPath);
  useEffect(() => {
    let live = true;
    const status = () => { void api.invoke('compat:status').then((r) => { if (live) setCompat(r); }).catch(() => undefined); };
    const list = (refresh: boolean) => { void api.invoke('compat:releases', { refresh }).then((r) => { if (live) setReleases(r); }).catch(() => undefined); };
    status(); list(false);
    const a = setInterval(status, 3000), b = setInterval(() => list(false), 15 * 60_000);
    return () => { live = false; clearInterval(a); clearInterval(b); };
  }, [settings.protonPath]);
  const versions = releases?.releases.filter((r) => r.provider === provider) ?? [];
  const selected = versions.find((r) => r.id === releaseId) ?? versions[0];
  const installed = releases?.installed ?? [];
  const active = settings.protonPath || compat?.protonPath || '';
  return (
    <>
      <StatusCard
        icon="wine"
        tone={compat?.python3 === false ? 'warn' : active ? 'ok' : compat?.provisioning ? 'busy' : 'off'}
        title={active ? `${active.split('/').pop()?.replace(/^ge-/, '')} is ready` : compat?.provisioning ? 'Setting up GE-Proton…' : 'Proton installs on first use'}
        detail={compat?.python3 === false
          ? 'Python 3 is missing. Install python3 with your distribution’s package manager, then restart the launcher.'
          : 'Windows games run through Proton via umu-launcher, with a separate prefix per game. Pressing Play while Proton is still installing starts the game when it is ready.'}
      >
        {!active && !compat?.provisioning && <Button variant="primary" disabled={busy || compat?.python3 === false} onClick={() => { setBusy(true); void attempt(async () => setCompat(await api.invoke('compat:installProton'))).finally(() => setBusy(false)); }}>Install GE-Proton now</Button>}
      </StatusCard>

      <Group title="Active version">
        <Row label="Proton used for Windows games" desc="Choose any installed build. Automatic picks the newest detected installation.">
          <select className="input" value={settings.protonPath} onChange={(e) => void update({ protonPath: e.target.value })} aria-label="Active Proton">
            <option value="">Automatic</option>
            {settings.protonPath && !installed.some((p) => p.path === settings.protonPath) && <option value={settings.protonPath}>{settings.protonPath.split('/').pop()}</option>}
            {installed.map((p) => <option key={p.path} value={p.path}>{p.name}</option>)}
          </select>
        </Row>
        <Row label="Use a Proton folder" desc="For builds installed elsewhere, such as through Steam.">
          <Button variant="ghost" size="sm" icon="folder" onClick={() => void attempt(async () => { const dir = await api.invoke('settings:pickDirectory', { title: 'Choose a Proton folder' }); if (dir) await update({ protonPath: dir }); })}>Browse…</Button>
        </Row>
      </Group>

      <Group title="Install another version" aside={<Button size="sm" variant="ghost" icon="reload" disabled={busy} onClick={() => void attempt(async () => setReleases(await api.invoke('compat:releases', { refresh: true })))}>Refresh</Button>}>
        <Row label="Provider">
          <Choice label="Proton provider" value={provider} options={(releases?.providers ?? [{ id: 'ge', name: 'GE-Proton' }, { id: 'cachyos', name: 'CachyOS' }, { id: 'valve', name: 'Valve' }]).map((p) => ({ value: p.id, label: p.name.replace(/ Proton.*$/, '').replace(/^Valve.*/, 'Valve') }))} onChange={(v) => { setProvider(v); setReleaseId(''); }} />
        </Row>
        <Row stacked label="Version" desc={selected?.unavailableReason ?? 'Verified against the published checksum before it is installed. New releases never replace your active version by themselves.'}>
          <div className="st-inline">
            <select className="input" value={selected?.id ?? ''} onChange={(e) => setReleaseId(e.target.value)} disabled={!versions.length} aria-label="Proton version">
              {!versions.length && <option value="">Loading releases…</option>}
              {versions.map((r) => <option key={r.id} value={r.id}>{r.name || r.version}{r.prerelease ? ' (pre-release)' : ''}</option>)}
            </select>
            <Button variant="primary" disabled={!selected || !!selected.unavailableReason || busy || !!compat?.provisioning} onClick={() => { if (!selected) return; setBusy(true); void attempt(async () => setCompat(await api.invoke('compat:installVersion', { id: selected.id }))).finally(() => setBusy(false)); }}>{compat?.provisioning ? 'Installing…' : 'Install'}</Button>
            {selected && <IconButton icon="external" label="Release notes" onClick={() => void attempt(() => api.invoke('compat:openRelease', { id: selected.id }))} />}
          </div>
        </Row>
      </Group>

      <details className="st-advanced">
        <summary><Icon name="sliders" size={16} /> Advanced</summary>
        <Group>
          <Row label="Wine executable" desc={info?.detectedWine ? `Detected: ${info.detectedWine}` : 'Optional. Wine was not found on this system; Proton does not need it.'}>
            <input className="input mono" placeholder={info?.detectedWine ?? 'wine'} value={wine} onChange={(e) => setWine(e.target.value)} onBlur={() => wine !== settings.winePath && void update({ winePath: wine.trim() })} aria-label="Wine executable" />
          </Row>
          <Row label="umu-launcher" desc="Leave empty for the bundled copy. Its first use downloads the Steam Linux Runtime.">
            <input className="input mono" placeholder="Bundled umu-run" value={umu} onChange={(e) => setUmu(e.target.value)} onBlur={() => umu !== settings.umuPath && void update({ umuPath: umu.trim() })} aria-label="umu-launcher path" />
          </Row>
        </Group>
      </details>
    </>
  );
}

function DownloadSection({ settings }: { settings: Settings }) {
  const pick = async (key: 'libraryDir' | 'downloadsDir', title: string) => {
    const dir = await attempt(() => api.invoke('settings:pickDirectory', { title }));
    if (dir) await update({ [key]: dir });
  };
  return (
    <>
      <Group title="Running in the background">
        <Row label="Keep running when the window is closed" desc="The launcher stays in the system tray so downloads, game preparation and update checks continue. Quit from the tray icon.">
          <Choice label="Close to tray" value={settings.closeToTray ? 'on' : 'off'} options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} onChange={(v) => void update({ closeToTray: v === 'on' })} />
        </Row>
      </Group>
      <Group title="Game updates">
        <Row label="When an installed game has a new version" desc="Installed games are checked in the background on the same schedule as indexing, even outside the Store. Your saves are carried into the new version and the previous one is kept until you have played it, so you can roll back.">
          <Choice label="Game updates" value={settings.gameUpdates} options={[{ value: 'notify', label: 'Tell me' }, { value: 'auto', label: 'Update automatically' }]} onChange={(v) => void update({ gameUpdates: v })} />
        </Row>
        <Row label="After a game is installed" desc="Downloaded archives can be as big as the game itself. Deleting them frees the space; the installed game keeps working (re-downloading is needed only to reinstall).">
          <Choice label="After a game is installed" value={settings.afterInstall} options={[{ value: 'ask', label: 'Ask me' }, { value: 'delete', label: 'Delete the download' }, { value: 'keep', label: 'Keep it' }]} onChange={(v) => void update({ afterInstall: v })} />
        </Row>
        <Row label="Back up saves automatically" desc="After each play session of a minute or more, and before updates, rollbacks and uninstalls. Restore them from the game's Launch options in the Library.">
          <Choice label="Save backups" value={settings.saveBackups ? 'on' : 'off'} options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} onChange={(v) => void update({ saveBackups: v === 'on' })} />
        </Row>
        <Row label="Backups kept per game">
          <Choice label="Backups kept" value={String(settings.saveBackupsKeep)} options={[3, 5, 10, 20].map((n) => ({ value: String(n), label: String(n) }))} onChange={(v) => void update({ saveBackupsKeep: Number(v) })} />
        </Row>
        <Row label="Check installed games now" desc="Reads each installed game’s page and compares its version, download files and date with what you have.">
          <Button size="sm" variant="ghost" icon="reload" onClick={() => void attempt(() => api.invoke('library:checkUpdates'), 'Checking installed games for updates…')}>Check now</Button>
        </Row>
      </Group>
      <Group title="Speed">
        <Row label="Connections per file" desc="Large files are split into parallel ranges when the host allows it; other hosts automatically use one connection.">
          <Choice label="Connections per file" value={String(settings.downloadConnections)} options={[1, 2, 4, 8, 16].map((n) => ({ value: String(n), label: String(n) }))} onChange={(v) => void update({ downloadConnections: Number(v) })} />
        </Row>
        <Row label="Downloads at once" desc="Fewer simultaneous files give each one more bandwidth.">
          <Range label="Simultaneous downloads" value={settings.maxConcurrentDownloads} min={1} max={6} onCommit={(v) => void update({ maxConcurrentDownloads: v })} />
        </Row>
      </Group>
      <Group title="Folders">
        <Row label="Games" desc={<span className="mono">{settings.libraryDir}</span>}>
          <div className="st-inline">
            <IconButton icon="folder" label="Open games folder" onClick={() => void attempt(() => api.invoke('app:openFolder', { which: 'games' }))} />
            <Button size="sm" variant="ghost" onClick={() => void pick('libraryDir', 'Choose the games folder')}>Change…</Button>
          </div>
        </Row>
        <Row label="Downloads" desc={<span className="mono">{settings.downloadsDir}</span>}>
          <div className="st-inline">
            <IconButton icon="folder" label="Open downloads folder" onClick={() => void attempt(() => api.invoke('app:openFolder', { which: 'downloads' }))} />
            <Button size="sm" variant="ghost" onClick={() => void pick('downloadsDir', 'Choose the downloads folder')}>Change…</Button>
          </div>
        </Row>
        <p className="st-note">Archives are extracted into the games folder, one folder per game. Partial downloads resume after a restart. Existing games stay where they are.</p>
      </Group>
    </>
  );
}

function ContentSection({ settings }: { settings: Settings }) {
  const [dialog, setDialog] = useState(false);
  const [consentAt, setConsentAt] = useState<string | null>(null);
  useEffect(() => { void api.invoke('consent:get').then((c) => setConsentAt(c.acceptedAt)); }, [settings.showNsfw]);
  return (
    <>
      <Group>
        <Row label="Show adult (NSFW) games" desc={settings.showNsfw ? `Shown with an NSFW badge.${consentAt ? ` You confirmed you are 18+ on ${new Date(consentAt).toLocaleString()}.` : ''}` : 'Hidden. Browser previews of adult pages are masked too.'}>
          <Switch checked={settings.showNsfw} label="Show adult games" onChange={(v) => { if (v) setDialog(true); else void attempt(() => api.invoke('consent:disableNsfw'), 'Adult content is hidden again.'); }} />
        </Row>
      </Group>
      <ul className="st-facts">
        <li>Every game’s artwork and text is checked by a local classifier (on your GPU) before it appears. Unchecked games stay hidden.</li>
        <li>Turning this off applies immediately, including to cached results.</li>
        <li>Turning it on again asks for confirmation again. It never starts downloads.</li>
        <li>Automatic classification is good but not perfect.</li>
      </ul>
      <ConsentDialog open={dialog} onCancel={() => setDialog(false)} onAccept={() => { setDialog(false); void attempt(() => api.invoke('consent:enableNsfw', { acceptedWarning: true })); }} />
    </>
  );
}

function AppearanceSection({ settings }: { settings: Settings }) {
  return (
    <Group>
      <Row label="Visual effects" desc="Full: bloom, light rays, particle streams, nebula and holographic cards. Low: lighter scene for older GPUs or while gaming.">
        <Choice label="Visual effects" value={settings.effects} options={[{ value: 'full', label: 'Full' }, { value: 'low', label: 'Low' }]} onChange={(v) => void update({ effects: v })} />
      </Row>
      <Row label="Motion" desc="Reduced stops camera drift, warps, card tilt and title animations.">
        <Choice label="Motion" value={settings.motion} options={[{ value: 'system', label: 'System' }, { value: 'reduced', label: 'Reduced' }, { value: 'full', label: 'Full' }]} onChange={(v) => void update({ motion: v })} />
      </Row>
    </Group>
  );
}

const SOUND_GROUPS: Array<{ id: SoundGroup; label: string; desc: string; preview: SoundName }> = [
  { id: 'hover', label: 'Hover', desc: 'Soft notes when the pointer moves over buttons and games.', preview: 'hover' },
  { id: 'click', label: 'Clicks', desc: 'Taps for buttons and switches.', preview: 'click' },
  { id: 'navigation', label: 'Navigation', desc: 'Warp between tabs; opening and closing game details.', preview: 'warp' },
  { id: 'downloads', label: 'Downloads', desc: 'A download starting, and a game becoming ready to play.', preview: 'success' },
  { id: 'alerts', label: 'Alerts', desc: 'Notices and errors.', preview: 'notify' },
];

function SoundSection({ settings }: { settings: Settings }) {
  const groups: SoundGroups = settings.uiSoundGroups ?? { hover: true, click: true, navigation: true, downloads: true, alerts: true };
  const on = settings.uiSounds;
  return (
    <>
      <Group>
        <Row label="Interface sounds" desc="Synthesized live on your computer: no audio files.">
          <Switch checked={on} label="Interface sounds" onChange={(v) => { void update({ uiSounds: v }); if (v) sound.play('success', { force: true }); }} />
        </Row>
        <Row label="Main volume">
          <Range label="Main volume" value={Math.round(settings.uiVolume * 100)} min={0} max={100} step={5} unit="%" onCommit={(v) => { void update({ uiVolume: v / 100 }); sound.play('click', { force: true, volume: v / 100 }); }} />
        </Row>
      </Group>
      <Group title="Sound groups">
        {SOUND_GROUPS.map((g) => (
          <Row key={g.id} label={g.label} desc={g.desc}>
            <div className="st-inline">
              <IconButton icon="play" label={`Preview ${g.label}`} onClick={() => sound.play(g.preview, { force: true })} />
              <Switch checked={groups[g.id]} disabled={!on} label={`${g.label} sounds`} onChange={(v) => void update({ uiSoundGroups: { ...groups, [g.id]: v } })} />
            </div>
          </Row>
        ))}
      </Group>
      <Group title="Ambience">
        <Row label="Ambient soundscape" desc="A soft evolving pad under the interface that brightens while the AI works. Paused when the window is hidden.">
          <Switch checked={settings.uiAmbient} disabled={!on} label="Ambient soundscape" onChange={(v) => void update({ uiAmbient: v })} />
        </Row>
        <Row label="Ambience volume">
          <Range label="Ambience volume" value={Math.round(settings.uiAmbientVolume * 100)} min={0} max={100} step={5} unit="%" onCommit={(v) => void update({ uiAmbientVolume: v / 100 })} />
        </Row>
      </Group>
    </>
  );
}

function PrivacySection({ settings }: { settings: Settings }) {
  const clear = async (what: 'artwork' | 'ai' | 'browser' | 'catalog', label: string) => {
    const r = await attempt(() => api.invoke('settings:clearCache', { what }));
    if (r) pushToast('success', `${label} cleared${r.freedBytes ? ` (${formatBytes(r.freedBytes)})` : ''}.`);
  };
  return (
    <>
      <Group>
        <Row label="Ask websites not to track me" desc="Sends Do Not Track and Global Privacy Control from the launcher’s Firefox.">
          <Switch checked={settings.sendDoNotTrack} label="Do Not Track" onChange={(v) => void update({ sendDoNotTrack: v })} />
        </Row>
        <Row label="Clear browser data when quitting" desc="Removes cookies and sign-ins from the launcher’s Firefox on exit. Sites that needed a human check will ask again.">
          <Switch checked={settings.clearBrowserDataOnExit} label="Clear browser data on exit" onChange={(v) => void update({ clearBrowserDataOnExit: v })} />
        </Row>
      </Group>
      <Group title="Stored data">
        <Row label="Browser data" desc="Cookies, sign-ins and site checks."><Button size="sm" variant="secondary" icon="trash" onClick={() => void clear('browser', 'Browser data')}>Clear</Button></Row>
        <Row label="Artwork cache" desc="Downloaded covers and screenshots; fetched again when needed."><Button size="sm" variant="secondary" icon="trash" onClick={() => void clear('artwork', 'Artwork cache')}>Clear</Button></Row>
        <Row label="AI answer cache"><Button size="sm" variant="secondary" icon="trash" onClick={() => void clear('ai', 'AI cache')}>Clear</Button></Row>
        <Row label="Discovered games" desc="Forgets every indexed game. Your Library and downloads stay."><Button size="sm" variant="danger" icon="trash" onClick={() => void clear('catalog', 'Catalog')}>Forget</Button></Row>
      </Group>
      <p className="st-note">Everything stays on this computer: no accounts, no telemetry, no cloud AI.</p>
    </>
  );
}

function AboutSection() {
  const info = useApp((s) => s.info);
  const ready = info?.vendorReady ?? {};
  const components: Array<[string, string, string, string?]> = [
    ['firefox', 'Mozilla Firefox ESR', 'MPL-2.0'],
    ['geckodriver', 'geckodriver', 'MPL-2.0'],
    ['ublock', 'uBlock Origin', 'GPL-3.0'],
    ['llama', 'llama.cpp', 'MIT'],
    ['classifier', 'vit-base-nsfw-detector (fp16, GPU)', 'Apache-2.0'],
    ['umu', 'umu-launcher', 'GPL-3.0'],
    ['model', 'Fara1.5-9B by Microsoft', 'MIT', 'downloaded on demand'],
  ];
  return (
    <>
      <StatusCard icon="sparkle" tone="ok" title={`Cool Games Launcher ${info?.appVersion ?? ''}`} detail="Free software under the GNU General Public License, version 3 or later.">
        <Button size="sm" variant="secondary" icon="folder" onClick={() => void attempt(() => api.invoke('app:openFolder', { which: 'logs' }))}>Open log folder</Button>
      </StatusCard>
      <Group title="Problems?">
        <Row label="Create a diagnostics file" desc="Writes one text file to your Downloads folder with the launcher's state, recent downloads and their errors, and the end of its logs (your home folder is shortened to ~). Send it with a description of what went wrong.">
          <Button size="sm" variant="secondary" icon="downloads" onClick={() => void attempt(async () => { const r = await api.invoke('app:diagnostics'); pushToast('success', `Saved ${r.path.split('/').pop()} in your Downloads folder.`); })}>Create file</Button>
        </Row>
      </Group>
      <Group title="Components">
        <ul className="st-components">
          {components.map(([key, name, license, note]) => (
            <li key={key}>
              <span className={`status-dot ${note || ready[key] ? 'is-ok' : 'is-missing'}`} aria-hidden="true" />
              <span>{name}</span>
              <span className="muted">{license}</span>
              <span className="muted">{note ?? (ready[key] ? 'bundled' : 'missing')}</span>
            </li>
          ))}
        </ul>
      </Group>
      <Group title="Keyboard">
        <dl className="st-keys">
          <dt><kbd>Ctrl</kbd> + <kbd>1</kbd>–<kbd>4</kbd></dt><dd>Switch tabs</dd>
          <dt><kbd>/</kbd></dt><dd>Search the Store</dd>
          <dt><kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd></dt><dd>Move between games and tabs</dd>
          <dt><kbd>Enter</kbd></dt><dd>Open the focused game</dd>
          <dt><kbd>Esc</kbd></dt><dd>Close details, dialogs and browser focus</dd>
        </dl>
      </Group>
      <Group title="Where things are">
        <dl className="st-paths">
          <dt>Data</dt><dd className="mono">{info?.dataDir}</dd>
          <dt>Cache</dt><dd className="mono">{info?.cacheDir}</dd>
          <dt>Config</dt><dd className="mono">{info?.configDir}</dd>
        </dl>
      </Group>
      <p className="st-note">Only download games you are allowed to download. The launcher never bypasses DRM, purchases, sign-ins or CAPTCHAs. This program comes with absolutely no warranty, to the extent permitted by law.</p>
    </>
  );
}
