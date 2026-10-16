import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { KineticTitle } from '../components/KineticTitle';
import { RECOMMENDED_MODEL_ID, type ModelList, type ModelOption } from '@shared/models';
import type { LauncherUpdate, ProtonInstall, ProtonReleaseList, Settings, SoundGroup, SoundGroups, Source } from '@shared/types';
import { formatBytes } from '@shared/format';
import { api } from '../api';
import { attempt, pushToast, useApp } from '../state';
import { Button, Dialog, IconButton } from '../components/ui';
import { ConsentDialog } from '../components/ConsentDialog';
import { Icon, type IconName } from '../components/Icon';
import { sound, type SoundName } from '../sound';
import { useMotionPrefs } from '../hooks/useMotion';
import { t, tk, locale } from '../i18n';

type SectionId = 'sources' | 'ai' | 'compat' | 'downloads' | 'content' | 'appearance' | 'sound' | 'privacy' | 'about';

interface SectionDef { id: SectionId; label: string; icon: IconName; blurb: string; keywords: string }

const SECTIONS: SectionDef[] = [
  { id: 'sources', label: tk('Websites & indexing'), icon: 'globe', blurb: tk('Sites the AI indexes, and how often'), keywords: 'websites sources add site rescan pages batch request gap rate limit refresh re-check interval indexing crawl learned layout' },
  { id: 'ai', label: tk('Local AI'), icon: 'cpu', blurb: tk('Model, GPU and performance'), keywords: 'ai model fara download gpu vulkan cpu threads context unload memory vram acceleration legacy holo qwen playing game free' },
  { id: 'compat', label: tk('Windows games'), icon: 'wine', blurb: tk('Proton, Wine and umu'), keywords: 'windows proton ge cachyos valve wine umu compatibility runtime python' },
  { id: 'downloads', label: tk('Downloads & updates'), icon: 'downloads', blurb: tk('Game updates, speed and folders'), keywords: 'downloads connections parallel simultaneous folders games library storage path disk updates update automatic new version patch rollback saves' },
  { id: 'content', label: tk('Content'), icon: 'shield', blurb: tk('Adult-content visibility'), keywords: 'nsfw adult content consent classifier safe mature woman women female girl anime cover filter' },
  { id: 'appearance', label: tk('Appearance'), icon: 'palette', blurb: tk('Effects and motion'), keywords: 'appearance effects motion animation reduced low 3d visuals language arabic english rtl العربية لغة' },
  { id: 'sound', label: tk('Sound'), icon: 'volume', blurb: tk('Interface sounds'), keywords: 'sound audio volume hover click navigation funny fart close mute alerts downloads' },
  { id: 'privacy', label: tk('Privacy & data'), icon: 'lock', blurb: tk('Tracking and stored data'), keywords: 'privacy tracking do not track cookies clear cache browser data forget catalog' },
  { id: 'about', label: tk('About'), icon: 'info', blurb: tk('Version, logs and licences'), keywords: 'about version license logs folder keyboard shortcuts components' },
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
    return SECTIONS.filter((s) => `${s.label} ${s.blurb} ${t(s.label)} ${t(s.blurb)} ${s.keywords}`.toLowerCase().includes(q));
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
            <p className="eyebrow">{t('Control')}</p>
            <KineticTitle text={t('Settings')} />
          </div>
        </header>
        <div className="st">
          <nav className="st__nav" aria-label={t('Settings sections')}>
            <label className="st__search">
              <Icon name="search" size={16} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Search settings')} aria-label={t('Search settings')} />
              {query && <button className="st__search-clear" onClick={() => setQuery('')} aria-label={t('Clear search')}><Icon name="close" size={14} /></button>}
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
                      <span className="st__tab-label">{t(s.label)}</span>
                      <span className="st__tab-status">{status[s.id] ?? t(s.blurb)}</span>
                    </span>
                  </button>
                </li>
              ))}
              {!visible.length && <li className="st__empty">{t('No settings match “{query}”.', { query })}</li>}
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
                    <h2>{t(current.label)}</h2>
                    <p>{t(current.blurb)}</p>
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

const MOTION_STATUS: Record<Settings['motion'], string> = { system: tk('system motion'), reduced: tk('reduced motion'), full: tk('full motion') };

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
    sources: sources.length ? `${sources.length === 1 ? t('1 site') : t('{n} sites', { n: sources.length })} · ${t('{n} games', { n: games })}` : t('No websites yet'),
    ai: fara?.installed ? `${fara.name} · ${ai.modelLoaded ? t('loaded') : t('ready')}${ai.accel ? ` · ${ai.accel === 'vulkan' ? t('GPU') : t('CPU')}` : ''}` : fara ? t('Download required') : undefined,
    compat: settings.protonPath ? t('Default: {name}', { name: protonName(settings.protonPath) }) : t('Installs on first use'),
    downloads: t('{n} connections · {m} at once', { n: settings.downloadConnections, m: settings.maxConcurrentDownloads }),
    content: `${settings.showNsfw ? t('Adult content shown') : t('Adult content hidden')}${settings.hideWomenCovers ? ` · ${t('cover filter on')}` : ''}`,
    appearance: `${settings.effects === 'full' ? t('Full effects') : t('Low effects')} · ${t(MOTION_STATUS[settings.motion])}`,
    sound: settings.uiSounds ? `${t('On')} · ${Math.round(settings.uiVolume * 100)}%` : t('Off'),
    privacy: settings.sendDoNotTrack ? t('Do Not Track on') : t('Do Not Track off'),
    about: info ? t('Version {v}', { v: info.appVersion }) : undefined,
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
          {t(o.label)}
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
  idle: tk('Waiting'), crawling: tk('Indexing'), ok: tk('Up to date'), blocked: tk('Needs a check'), unsupported: tk('No games found'), error: tk('Error'),
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
    if (r) { setUrl(''); setName(''); pushToast('success', t('Added {name}. The AI learns its layout the next time the Store is open.', { name: r.name })); }
  };
  return (
    <>
      <Group title={t('Add a website')}>
        <form className="st-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <input className="input" placeholder={t('https://site.example/games')} value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" aria-label={t('Website address')} />
          <input className="input" placeholder={t('Name (optional)')} value={name} onChange={(e) => setName(e.target.value)} aria-label={t('Website name')} />
          <Button variant="primary" icon="plus" type="submit" disabled={!url.trim()}>{t('Add')}</Button>
        </form>
        <p className="st-note">{t('Use a page that lists games (“browse”, “new releases”). The local AI learns each site’s layout once, then indexes it quickly; pages that need a person’s check are skipped and retried.')}</p>
      </Group>
      {sources.length > 0 && (
        <Group title={t('Your websites')}>
          <ul className="st-sources">{sources.map((s) => <SourceCard key={s.id} s={s} />)}</ul>
        </Group>
      )}
      <Group title={t('Indexing')}>
        <Row label={t('Check for new games every')} desc={t('Indexed sites are re-checked while the Store is open. Re-checks stop as soon as listings show nothing new; a full walk runs weekly.')}>
          <Choice label={t('Re-check interval')} value={String(settings.crawlRefreshHours)} options={[1, 3, 6, 12, 24].map((h) => ({ value: String(h), label: t('{n} h', { n: h }) }))} onChange={(v) => void update({ crawlRefreshHours: Number(v) })} />
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
            <span className="st-chip">{t(STATUS_TEXT[s.status])}</span>
            <span className="st-chip">{t('{n} games', { n: s.entryCount })}</span>
            {s.learned && <span className="st-chip st-chip--ai" title={t('Layout learned {when}', { when: new Date(s.learned.at).toLocaleString(locale()) })}>{t('AI learned layout')}{s.learned.browser ? t(' · via Firefox') : ''}</span>}
            {s.lastCrawlAt && <span className="st-chip st-chip--muted">{t('checked {when}', { when: new Date(s.lastCrawlAt).toLocaleString(locale()) })}</span>}
          </div>
          {s.statusDetail && <p className="st-source__detail">{s.statusDetail}</p>}
        </div>
        <div className="st-source__actions">
          <Switch checked={s.enabled} label={s.enabled ? t('Disable {name}', { name: s.name }) : t('Enable {name}', { name: s.name })} onChange={(v) => void attempt(() => api.invoke('sources:update', { id: s.id, enabled: v }))} />
          <IconButton icon="reload" label={t('Check {name} for new games now', { name: s.name })} onClick={() => void attempt(() => api.invoke('sources:recrawl', { id: s.id }), t('Queued — it runs while the Store is open.'))} />
          <IconButton icon="sliders" label={t('Options for {name}', { name: s.name })} aria-expanded={open} onClick={() => setOpen(!open)} />
          <IconButton icon="trash" label={t('Remove {name}', { name: s.name })} onClick={() => void attempt(() => api.invoke('sources:remove', { id: s.id }))} />
        </div>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="st-source__options" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25 }}>
            <Row label={t('Listing pages per batch')} desc={t('Each batch is checkpointed; indexing continues with the next batch while the Store stays open.')}>
              <Range label={t('Pages per batch')} value={s.maxPages} min={1} max={50} onCommit={(v) => void attempt(() => api.invoke('sources:update', { id: s.id, maxPages: v }))} />
            </Row>
            <Row label={t('Minimum gap between requests')} desc={t('Politeness floor. It slows down further by itself when the site asks (HTTP 429).')}>
              <Range label={t('Request gap')} value={s.rateLimitMs} min={100} max={5000} step={100} unit="ms" onCommit={(v) => void attempt(() => api.invoke('sources:update', { id: s.id, rateLimitMs: v }))} />
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
            ? `${!ai.modelLoaded ? t('Installed — loads when the Store opens.') : ai.accel === 'vulkan' ? t('Loaded on the GPU (Vulkan).') : ai.accel ? t('Loaded on the CPU.') : t('Loaded.')} ${t('One model handles browsing, page analysis and choosing game executables.')}`
            : downloading(fara) ? t('Downloading… {p}% (pause or resume in Downloads)', { p: Math.round(progress(fara) * 100) }) : t('Microsoft’s computer-use model. Download it once; it stays outside the AppImage and is SHA-256 verified.')}
        >
          {!fara.installed && <Button variant="primary" icon="downloads" disabled={busy || downloading(fara)} onClick={() => act(() => api.invoke('models:download', { id: fara.id }))}>{downloading(fara) ? t('Downloading…') : t('Download')}</Button>}
          {fara.installed && !singleModel && <Button variant="primary" disabled={busy} onClick={() => act(() => api.invoke('models:assignAll', { id: fara.id }))}>{t('Use for everything')}</Button>}
        </StatusCard>
      )}
      {fara && !fara.installed && downloading(fara) && <div className="st-progress"><span style={{ width: `${progress(fara) * 100}%` }} /></div>}

      <Group title={t('Performance')}>
        <Row label={t('Acceleration')} desc={info?.vulkanAvailable ? t('Vulkan was found. Automatic uses the GPU and falls back to the CPU if it cannot start.') : t('No Vulkan loader found, so the CPU build is used.')}>
          <Choice label={t('Acceleration')} value={settings.aiAcceleration} options={[{ value: 'auto', label: tk('Automatic') }, { value: 'vulkan', label: tk('GPU') }, { value: 'cpu', label: tk('CPU') }]} onChange={(v) => void update({ aiAcceleration: v })} />
        </Row>
        <Row label={t('CPU threads')} desc={t('Of {n}. Used for parts that run on the CPU; fewer keeps games and the desktop responsive.', { n: cores })}>
          <Range label={t('CPU threads')} value={settings.aiThreads} min={1} max={Math.max(2, cores)} onCommit={(v) => void update({ aiThreads: v })} />
        </Row>
        <Row label={t('Free the GPU when idle after')} desc={t('Unloads the model when the AI has nothing to do, so games get all of the video memory. It reloads in a few seconds when needed.')}>
          <Range label={t('Unload when idle')} value={settings.aiIdleUnloadMinutes} min={0} max={60} unit={t('min')} format={(v) => (v === 0 ? t('Never') : t('{n} min', { n: v }))} onCommit={(v) => void update({ aiIdleUnloadMinutes: v })} />
        </Row>
        <Row label={t('Free the GPU while playing')} desc={t('Unloads the model while a game from the Library is running and pauses AI work until it closes. Downloads keep going.')}>
          <Switch checked={settings.freeGpuWhilePlaying} label={t('Free the GPU while playing')} onChange={(v) => void update({ freeGpuWhilePlaying: v })} />
        </Row>
      </Group>

      <details className="st-advanced">
        <summary><Icon name="sliders" size={16} /> {' '}{t('Advanced')}</summary>
        <Group>
          <Row label={t('Context size')} desc={t('How much the model can keep in mind at once. 16K holds three screenshots plus the conversation; 32K uses more memory.')}>
            <Choice label={t('Context size')} value={String(Math.max(16384, settings.aiContextSize))} options={[{ value: '16384', label: '16K' }, { value: '32768', label: '32K' }]} onChange={(v) => void update({ aiContextSize: Number(v) })} />
          </Row>
          <Row label={t('Other models')} desc={t('Older specialist models stay available for existing installations. The recommended setup uses one model for every role.')} stacked>
            <ul className="st-models">
              {models?.models.filter((m) => m.id !== RECOMMENDED_MODEL_ID).map((m) => {
                const roles = models.agents.filter((a) => a.modelId === m.id).map((a) => a.role);
                return (
                  <li key={m.id}>
                    <span><strong>{m.name}</strong> <span className="muted">{m.quantization} · {formatBytes(m.bytes)}{m.installed ? t(' · installed') : ''}{roles.length ? t(' · used for {roles}', { roles: roles.join(', ') }) : ''}</span></span>
                    {!m.installed && <Button size="sm" variant="ghost" disabled={busy || downloading(m)} onClick={() => act(() => api.invoke('models:download', { id: m.id }))}>{downloading(m) ? `${Math.round(progress(m) * 100)}%` : t('Download')}</Button>}
                  </li>
                );
              })}
            </ul>
          </Row>
        </Group>
      </details>
      <p className="st-note">{t('The AI only works while the Store is open. Downloads keep going when you leave; games never start by themselves.')}</p>
    </>
  );
}

/** "GE-Proton10-25" from a Proton folder (launcher installs are named "<provider>-<version>"). */
const protonName = (path: string) => (path.split('/').pop() ?? path).replace(/^(ge|cachyos|valve)-/, '');

const PROVIDER_NAME: Record<string, string> = { ge: 'GE-Proton', cachyos: 'CachyOS', valve: 'Valve', other: 'Proton' };
const PROVIDER_HINT: Record<string, string> = {
  ge: tk('Community build with extra game fixes and media codecs. A good default.'),
  cachyos: tk('Performance-tuned build from CachyOS, often with the newest fixes.'),
  valve: tk('Official builds come with Steam: install them in Steam and they appear in the list above.'),
};
const SOURCE_TEXT: Record<ProtonInstall['source'], string> = { launcher: tk('Installed by the launcher'), system: tk('Found on this computer (Steam)'), folder: tk('Folder you added') };

/** Every installed Proton build: choose the default, remove the ones the launcher installed. */
function ProtonVersions({ settings, releases, onChanged }: { settings: Settings; releases: ProtonReleaseList | null; onChanged: (r: ProtonReleaseList) => void }) {
  const downloads = useApp((s) => s.downloads);
  const [removing, setRemoving] = useState<ProtonInstall | null>(null);
  const installed = releases?.installed ?? [];
  const reload = async () => onChanged(await api.invoke('compat:releases', { refresh: false }));
  const makeDefault = (path: string | null) => void attempt(async () => { await api.invoke('compat:setDefault', { path }); await reload(); });
  const automatic = !settings.protonPath || !installed.some((p) => p.path === settings.protonPath);
  const autoName = installed.find((p) => p.path === releases?.defaultPath)?.name;
  const pending = downloads.filter((d) => d.compatVersion && d.state !== 'cancelled' && !(d.state === 'completed' && (d.installState === 'installed' || d.installState === 'failed')));
  return (
    <Group title={t('Installed versions')} aside={<Button size="sm" variant="ghost" icon="folder" onClick={() => void attempt(async () => { const r = await api.invoke('compat:addFolder'); if (r) await reload(); })}>{t('Add a folder…')}</Button>}>
      <ul className="proton-list">
        <li className={`proton-list__item ${automatic ? 'is-default' : ''}`}>
          <div className="proton-list__text">
            <strong>{t('Automatic')}</strong>
            <span className="muted">{autoName ? t('Uses the newest found version: {name}', { name: autoName }) : t('Uses the newest version found on this computer.')}</span>
          </div>
          <div className="proton-list__actions">
            {automatic ? <span className="st-chip st-chip--ai">{t('Default')}</span> : <Button size="sm" variant="secondary" onClick={() => makeDefault(null)}>{t('Make default')}</Button>}
          </div>
        </li>
        {installed.map((p) => {
          const isDefault = !automatic && settings.protonPath === p.path;
          return (
            <li key={p.path} className={`proton-list__item ${isDefault ? 'is-default' : ''}`}>
              <div className="proton-list__text">
                <strong>{p.name}</strong>
                <span className="proton-list__chips">
                  <span className={`st-chip proton-chip--${p.provider}`}>{PROVIDER_NAME[p.provider]}</span>
                  {p.usedBy ? <span className="st-chip st-chip--muted">{p.usedBy === 1 ? t('1 game uses it') : t('{n} games use it', { n: p.usedBy })}</span> : null}
                  <span className="muted">{t(SOURCE_TEXT[p.source])}</span>
                </span>
              </div>
              <div className="proton-list__actions">
                {isDefault ? <span className="st-chip st-chip--ai">{t('Default')}</span> : <Button size="sm" variant="secondary" onClick={() => makeDefault(p.path)}>{t('Make default')}</Button>}
                {p.removable && <IconButton icon="trash" label={p.source === 'launcher' ? t('Remove {name}', { name: p.name }) : t('Forget {name}', { name: p.name })} onClick={() => setRemoving(p)} />}
              </div>
            </li>
          );
        })}
        {pending.map((d) => (
          <li key={d.id} className="proton-list__item is-pending">
            <div className="proton-list__text">
              <strong>{d.compatVersion}</strong>
              <span className="muted">{d.state === 'completed' ? (d.installDetail ?? t('Installing…')) : d.totalBytes ? t('Downloading… {p}%', { p: Math.round((d.receivedBytes / d.totalBytes) * 100) }) : t('Downloading…')}</span>
            </div>
          </li>
        ))}
      </ul>
      {!installed.length && !pending.length && <p className="st-note">{t('No Proton yet. Install GE-Proton below; Windows games also install it by themselves on first Play.')}</p>}
      <Dialog
        open={!!removing}
        title={removing?.source === 'launcher' ? t('Remove {name}?', { name: removing?.name ?? '' }) : t('Forget {name}?', { name: removing?.name ?? '' })}
        onClose={() => setRemoving(null)}
        actions={<>
          <Button variant="secondary" onClick={() => setRemoving(null)}>{t('Cancel')}</Button>
          <Button variant="danger" icon="trash" onClick={() => { const p = removing!; setRemoving(null); void attempt(async () => { await api.invoke('compat:remove', { path: p.path }); await reload(); }); }}>{removing?.source === 'launcher' ? t('Remove') : t('Forget')}</Button>
        </>}
      >
        <p>{removing?.source === 'launcher' ? t('Its files are deleted. You can install it again any time.') : t('The folder stays on your computer; the launcher just stops listing it.')} {removing?.usedBy ? t('Games that use it switch to the default version.') : ''}</p>
      </Dialog>
    </Group>
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
  // A version finishing its install appears in the list right away.
  const finished = useApp((s) => s.downloads.filter((d) => d.compatVersion && d.installState === 'installed').length);
  useEffect(() => {
    let live = true;
    const status = () => { void api.invoke('compat:status').then((r) => { if (live) setCompat(r); }).catch(() => undefined); };
    const list = (refresh: boolean) => { void api.invoke('compat:releases', { refresh }).then((r) => { if (live) setReleases(r); }).catch(() => undefined); };
    status(); list(false);
    const a = setInterval(status, 3000), b = setInterval(() => list(false), 15 * 60_000);
    return () => { live = false; clearInterval(a); clearInterval(b); };
  }, [settings.protonPath, finished]);
  const versions = releases?.releases.filter((r) => r.provider === provider) ?? [];
  const selected = versions.find((r) => r.id === releaseId) ?? versions[0];
  const installed = releases?.installed ?? [];
  const isInstalled = (version: string) => installed.some((p) => p.name === version || p.path.endsWith(`-${version}`));
  const active = settings.protonPath || compat?.protonPath || '';
  return (
    <>
      <StatusCard
        icon="wine"
        tone={compat?.python3 === false ? 'warn' : active ? 'ok' : compat?.provisioning ? 'busy' : 'off'}
        title={active ? t('Default: {name}', { name: protonName(active) }) : compat?.provisioning ? t('Setting up GE-Proton…') : t('Proton installs on first use')}
        detail={compat?.python3 === false
          ? t('Python 3 is missing. Install python3 with your distribution’s package manager, then restart the launcher.')
          : t('Windows games run through Proton via umu-launcher, with a separate prefix per game. Pressing Play while Proton is still installing starts the game when it is ready.')}
      >
        {!active && !compat?.provisioning && <Button variant="primary" disabled={busy || compat?.python3 === false} onClick={() => { setBusy(true); void attempt(async () => setCompat(await api.invoke('compat:installProton'))).finally(() => setBusy(false)); }}>{t('Install GE-Proton now')}</Button>}
      </StatusCard>

      <ProtonVersions settings={settings} releases={releases} onChanged={(r) => setReleases(r)} />

      <Group title={t('Get more versions')} aside={<Button size="sm" variant="ghost" icon="reload" disabled={busy} onClick={() => void attempt(async () => setReleases(await api.invoke('compat:releases', { refresh: true })))}>{t('Refresh')}</Button>}>
        <Row label={t('Provider')} desc={PROVIDER_HINT[provider] ? t(PROVIDER_HINT[provider]) : undefined}>
          <Choice label={t('Proton provider')} value={provider} options={(releases?.providers ?? [{ id: 'ge', name: 'GE-Proton' }, { id: 'cachyos', name: 'CachyOS' }, { id: 'valve', name: 'Valve' }]).map((p) => ({ value: p.id, label: PROVIDER_NAME[p.id] ?? p.name }))} onChange={(v) => { setProvider(v); setReleaseId(''); }} />
        </Row>
        <Row stacked label={t('Version')} desc={selected?.unavailableReason ?? t('Verified against the published checksum before it is installed. Installing never changes your default version: make it the default in the list above, or choose it for one game in its Launch options.')}>
          <div className="st-inline">
            <select className="input" value={selected?.id ?? ''} onChange={(e) => setReleaseId(e.target.value)} disabled={!versions.length} aria-label={t('Proton version')}>
              {!versions.length && <option value="">{t('Loading releases…')}</option>}
              {versions.map((r) => <option key={r.id} value={r.id}>{r.name || r.version}{r.prerelease ? t(' (pre-release)') : ''}{isInstalled(r.version) ? t(' · installed') : ''}</option>)}
            </select>
            <Button variant="primary" icon="downloads" disabled={!selected || !!selected.unavailableReason || busy || isInstalled(selected.version)} onClick={() => { if (!selected) return; setBusy(true); void attempt(async () => setCompat(await api.invoke('compat:installVersion', { id: selected.id }))).finally(() => setBusy(false)); }}>{selected && isInstalled(selected.version) ? t('Installed') : t('Install')}</Button>
            {selected && <IconButton icon="external" label={t('Release notes')} onClick={() => void attempt(() => api.invoke('compat:openRelease', { id: selected.id }))} />}
          </div>
        </Row>
      </Group>

      <details className="st-advanced">
        <summary><Icon name="sliders" size={16} /> {' '}{t('Advanced')}</summary>
        <Group>
          <Row label={t('Wine executable')} desc={info?.detectedWine ? t('Detected: {path}', { path: info.detectedWine }) : t('Optional. Wine was not found on this system; Proton does not need it.')}>
            <input className="input mono" placeholder={info?.detectedWine ?? t('wine')} value={wine} onChange={(e) => setWine(e.target.value)} onBlur={() => wine !== settings.winePath && void update({ winePath: wine.trim() })} aria-label={t('Wine executable')} />
          </Row>
          <Row label={t('umu-launcher')} desc={t('Leave empty for the bundled copy. Its first use downloads the Steam Linux Runtime.')}>
            <input className="input mono" placeholder={t('Bundled umu-run')} value={umu} onChange={(e) => setUmu(e.target.value)} onBlur={() => umu !== settings.umuPath && void update({ umuPath: umu.trim() })} aria-label={t('umu-launcher path')} />
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
      <Group title={t('Running in the background')}>
        <Row label={t('Keep running when the window is closed')} desc={t('The launcher stays in the system tray so downloads, game preparation and update checks continue. Quit from the tray icon.')}>
          <Choice label={t('Close to tray')} value={settings.closeToTray ? 'on' : 'off'} options={[{ value: 'on', label: tk('On') }, { value: 'off', label: tk('Off') }]} onChange={(v) => void update({ closeToTray: v === 'on' })} />
        </Row>
      </Group>
      <Group title={t('Game updates')}>
        <Row label={t('When an installed game has a new version')} desc={t('Installed games are checked in the background on the same schedule as indexing, even outside the Store. Your saves are carried into the new version and the previous one is kept until you have played it, so you can roll back.')}>
          <Choice label={t('Game updates')} value={settings.gameUpdates} options={[{ value: 'notify', label: tk('Tell me') }, { value: 'auto', label: tk('Update automatically') }]} onChange={(v) => void update({ gameUpdates: v })} />
        </Row>
        <Row label={t('After a game is installed')} desc={t('Downloaded archives can be as big as the game itself. Deleting them frees the space; the installed game keeps working (re-downloading is needed only to reinstall).')}>
          <Choice label={t('After a game is installed')} value={settings.afterInstall} options={[{ value: 'ask', label: tk('Ask me') }, { value: 'delete', label: tk('Delete the download') }, { value: 'keep', label: tk('Keep it') }]} onChange={(v) => void update({ afterInstall: v })} />
        </Row>
        <Row label={t('Back up saves automatically')} desc={t('After each play session of a minute or more, and before updates, rollbacks and uninstalls. Restore them from the game\'s Launch options in the Library.')}>
          <Choice label={t('Save backups')} value={settings.saveBackups ? 'on' : 'off'} options={[{ value: 'on', label: tk('On') }, { value: 'off', label: tk('Off') }]} onChange={(v) => void update({ saveBackups: v === 'on' })} />
        </Row>
        <Row label={t('Backups kept per game')}>
          <Choice label={t('Backups kept')} value={String(settings.saveBackupsKeep)} options={[3, 5, 10, 20].map((n) => ({ value: String(n), label: String(n) }))} onChange={(v) => void update({ saveBackupsKeep: Number(v) })} />
        </Row>
        <Row label={t('Check installed games now')} desc={t('Reads each installed game’s page and compares its version, download files and date with what you have.')}>
          <Button size="sm" variant="ghost" icon="reload" onClick={() => void attempt(() => api.invoke('library:checkUpdates'), t('Checking installed games for updates…'))}>{t('Check now')}</Button>
        </Row>
      </Group>
      <Group title={t('Speed')}>
        <Row label={t('Connections per file')} desc={t('Large files are split into parallel ranges when the host allows it; other hosts automatically use one connection.')}>
          <Choice label={t('Connections per file')} value={String(settings.downloadConnections)} options={[1, 2, 4, 8, 16].map((n) => ({ value: String(n), label: String(n) }))} onChange={(v) => void update({ downloadConnections: Number(v) })} />
        </Row>
        <Row label={t('Downloads at once')} desc={t('Fewer simultaneous files give each one more bandwidth.')}>
          <Range label={t('Simultaneous downloads')} value={settings.maxConcurrentDownloads} min={1} max={6} onCommit={(v) => void update({ maxConcurrentDownloads: v })} />
        </Row>
      </Group>
      <Group title={t('Folders')}>
        <Row label={t('Games')} desc={<span className="mono">{settings.libraryDir}</span>}>
          <div className="st-inline">
            <IconButton icon="folder" label={t('Open games folder')} onClick={() => void attempt(() => api.invoke('app:openFolder', { which: 'games' }))} />
            <Button size="sm" variant="ghost" onClick={() => void pick('libraryDir', t('Choose the games folder'))}>{t('Change…')}</Button>
          </div>
        </Row>
        <Row label={t('Downloads')} desc={<span className="mono">{settings.downloadsDir}</span>}>
          <div className="st-inline">
            <IconButton icon="folder" label={t('Open downloads folder')} onClick={() => void attempt(() => api.invoke('app:openFolder', { which: 'downloads' }))} />
            <Button size="sm" variant="ghost" onClick={() => void pick('downloadsDir', t('Choose the downloads folder'))}>{t('Change…')}</Button>
          </div>
        </Row>
        <p className="st-note">{t('Archives are extracted into the games folder, one folder per game. Partial downloads resume after a restart. Existing games stay where they are.')}</p>
      </Group>
    </>
  );
}

/** Hide games whose cover shows a woman as its main subject; the local AI checks every cover. */
function CoverFilterRow({ settings }: { settings: Settings }) {
  const [status, setStatus] = useState<{ checked: number; women: number; pending: number; enabled: boolean; aiReady: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => void api.invoke('content:coverStatus').then((r) => { if (live) setStatus(r); }).catch(() => undefined);
    load();
    const timer = setInterval(load, 2500);
    return () => { live = false; clearInterval(timer); };
  }, [settings.hideWomenCovers]);
  const on = settings.hideWomenCovers;
  let progress: string | null = null;
  if (on && status) {
    if (!status.aiReady) progress = t('The local AI is needed to check covers: download it in Settings → Local AI. Until then these games stay hidden.');
    else if (status.pending) progress = t('Checking covers: {done} of {total} done, {women} hidden so far. Games appear in the Store as soon as their cover is checked.', { done: status.checked, total: status.checked + status.pending, women: status.women });
    else progress = t('All {total} covers checked: {women} games are hidden.', { total: status.checked, women: status.women });
  }
  return (
    <Row label={t('Hide games with a woman on the cover')} desc={<>
      {t('The local AI looks at each game\'s cover and hides the game when a woman or female anime character is its main subject, even when the cover is not explicit. New games are checked as they are found.')}
      {progress && <span className="st-cover-progress">{progress}</span>}
    </>}>
      <Switch checked={on} label={t('Hide games with a woman on the cover')} onChange={(v) => void attempt(() => api.invoke('content:setHideWomenCovers', { on: v }))} />
    </Row>
  );
}

function ContentSection({ settings }: { settings: Settings }) {
  const [dialog, setDialog] = useState(false);
  const [consentAt, setConsentAt] = useState<string | null>(null);
  useEffect(() => { void api.invoke('consent:get').then((c) => setConsentAt(c.acceptedAt)); }, [settings.showNsfw]);
  return (
    <>
      <Group>
        <Row label={t('Show adult (NSFW) games')} desc={settings.showNsfw ? `${t('Shown with an NSFW badge.')}${consentAt ? ` ${t('You confirmed you are 18+ on {when}.', { when: new Date(consentAt).toLocaleString(locale()) })}` : ''}` : t('Hidden. Browser previews of adult pages are masked too.')}>
          <Switch checked={settings.showNsfw} label={t('Show adult games')} onChange={(v) => { if (v) setDialog(true); else void attempt(() => api.invoke('consent:disableNsfw'), t('Adult content is hidden again.')); }} />
        </Row>
        <CoverFilterRow settings={settings} />
      </Group>
      <ul className="st-facts">
        <li>{t('Every game’s artwork and text is checked by a local classifier (on your GPU) before it appears. Unchecked games stay hidden.')}</li>
        <li>{t('Turning this off applies immediately, including to cached results.')}</li>
        <li>{t('Turning it on again asks for confirmation again. It never starts downloads.')}</li>
        <li>{t('Automatic classification is good but not perfect.')}</li>
      </ul>
      <ConsentDialog open={dialog} onCancel={() => setDialog(false)} onAccept={() => { setDialog(false); void attempt(() => api.invoke('consent:enableNsfw', { acceptedWarning: true })); }} />
    </>
  );
}

function AppearanceSection({ settings }: { settings: Settings }) {
  return (
    <Group>
      <Row label={t('Language')} desc={t('Arabic shows the launcher right to left. Game titles and text from websites stay as they are.')}>
        <Choice label={t('Language')} value={settings.language} options={[{ value: 'en', label: 'English' }, { value: 'ar', label: 'العربية' }]} onChange={(v) => void update({ language: v })} />
      </Row>
      <Row label={t('Visual effects')} desc={t('Full: bloom, light rays, particle streams, nebula and holographic cards. Low: lighter scene for older GPUs or while gaming.')}>
        <Choice label={t('Visual effects')} value={settings.effects} options={[{ value: 'full', label: tk('Full') }, { value: 'low', label: tk('Low') }]} onChange={(v) => void update({ effects: v })} />
      </Row>
      <Row label={t('Motion')} desc={t('Reduced stops camera drift, warps, card tilt and title animations.')}>
        <Choice label={t('Motion')} value={settings.motion} options={[{ value: 'system', label: tk('System') }, { value: 'reduced', label: tk('Reduced') }, { value: 'full', label: tk('Full') }]} onChange={(v) => void update({ motion: v })} />
      </Row>
    </Group>
  );
}

const SOUND_GROUPS: Array<{ id: SoundGroup; label: string; desc: string; preview: SoundName }> = [
  { id: 'hover', label: tk('Hover'), desc: tk('Soft notes when the pointer moves over buttons and games.'), preview: 'hover' },
  { id: 'click', label: tk('Clicks'), desc: tk('Taps for buttons and switches.'), preview: 'click' },
  { id: 'navigation', label: tk('Navigation'), desc: tk('Warp between tabs; opening and closing game details.'), preview: 'warp' },
  { id: 'downloads', label: tk('Downloads'), desc: tk('A download starting, and a game becoming ready to play.'), preview: 'success' },
  { id: 'alerts', label: tk('Alerts'), desc: tk('Notices and errors.'), preview: 'notify' },
  { id: 'funny', label: tk('Funny sounds'), desc: tk('A rude noise when you close the window. Off: the window closes silently.'), preview: 'quit' },
];

function SoundSection({ settings }: { settings: Settings }) {
  // Settings saved before a group existed lack its key: such a group is on.
  const groups: SoundGroups = { ...{ hover: true, click: true, navigation: true, downloads: true, alerts: true, funny: true }, ...(settings.uiSoundGroups as Partial<SoundGroups>) };
  const on = settings.uiSounds;
  return (
    <>
      <Group>
        <Row label={t('Interface sounds')} desc={t('Synthesized live on your computer; only the close sound is a recording.')}>
          <Switch checked={on} label={t('Interface sounds')} onChange={(v) => { void update({ uiSounds: v }); if (v) sound.play('success', { force: true }); }} />
        </Row>
        <Row label={t('Main volume')}>
          <Range label={t('Main volume')} value={Math.round(settings.uiVolume * 100)} min={0} max={100} step={5} unit="%" onCommit={(v) => { void update({ uiVolume: v / 100 }); sound.play('click', { force: true, volume: v / 100 }); }} />
        </Row>
      </Group>
      <Group title={t('Sound groups')}>
        {SOUND_GROUPS.map((g) => (
          <Row key={g.id} label={t(g.label)} desc={t(g.desc)}>
            <div className="st-inline">
              <IconButton icon="play" label={t('Preview {name}', { name: t(g.label) })} onClick={() => sound.play(g.preview, { force: true })} />
              <Switch checked={groups[g.id]} disabled={!on} label={t('{name} sounds', { name: t(g.label) })} onChange={(v) => void update({ uiSoundGroups: { ...groups, [g.id]: v } })} />
            </div>
          </Row>
        ))}
      </Group>
    </>
  );
}

function PrivacySection({ settings }: { settings: Settings }) {
  const clear = async (what: 'artwork' | 'ai' | 'browser' | 'catalog', label: string) => {
    const r = await attempt(() => api.invoke('settings:clearCache', { what }));
    if (r) pushToast('success', r.freedBytes ? t('{what} cleared ({size}).', { what: t(label), size: formatBytes(r.freedBytes) }) : t('{what} cleared.', { what: t(label) }));
  };
  return (
    <>
      <Group>
        <Row label={t('Ask websites not to track me')} desc={t('Sends Do Not Track and Global Privacy Control from the launcher’s Firefox.')}>
          <Switch checked={settings.sendDoNotTrack} label={t('Do Not Track')} onChange={(v) => void update({ sendDoNotTrack: v })} />
        </Row>
        <Row label={t('Clear browser data when quitting')} desc={t('Removes cookies and sign-ins from the launcher’s Firefox on exit. Sites that needed a human check will ask again.')}>
          <Switch checked={settings.clearBrowserDataOnExit} label={t('Clear browser data on exit')} onChange={(v) => void update({ clearBrowserDataOnExit: v })} />
        </Row>
      </Group>
      <Group title={t('Stored data')}>
        <Row label={t('Browser data')} desc={t('Cookies, sign-ins and site checks.')}><Button size="sm" variant="secondary" icon="trash" onClick={() => void clear('browser', tk('Browser data'))}>{t('Clear')}</Button></Row>
        <Row label={t('Artwork cache')} desc={t('Downloaded covers and screenshots; fetched again when needed.')}><Button size="sm" variant="secondary" icon="trash" onClick={() => void clear('artwork', tk('Artwork cache'))}>{t('Clear')}</Button></Row>
        <Row label={t('AI answer cache')}><Button size="sm" variant="secondary" icon="trash" onClick={() => void clear('ai', tk('AI cache'))}>{t('Clear')}</Button></Row>
        <Row label={t('Discovered games')} desc={t('Forgets every indexed game. Your Library and downloads stay.')}><Button size="sm" variant="danger" icon="trash" onClick={() => void clear('catalog', tk('Catalog'))}>{t('Forget')}</Button></Row>
      </Group>
      <p className="st-note">{t('Everything stays on this computer: no accounts, no telemetry, no cloud AI.')}</p>
    </>
  );
}

function useLauncherUpdate() {
  const [update, setUpdate] = useState<LauncherUpdate | null>(null);
  useEffect(() => {
    let live = true;
    void api.invoke('launcher:updateStatus').then((u) => { if (live) setUpdate(u); }).catch(() => undefined);
    const off = api.on('launcher:update', (u) => { if (live) setUpdate(u); });
    return () => { live = false; off(); };
  }, []);
  return update;
}

function LauncherUpdates() {
  const settings = useApp((s) => s.settings);
  const u = useLauncherUpdate();
  if (!u || !settings) return null;
  const openPage = () => void attempt(() => api.invoke('app:openExternal', { url: u.pageUrl }));
  const checked = u.checkedAt ? ` ${t('Checked {when}.', { when: new Date(u.checkedAt).toLocaleString(locale()) })}` : '';
  let desc: ReactNode;
  let action: ReactNode = null;
  if (u.state === 'checking') {
    desc = t('Checking GitHub for a new version…');
  } else if (u.state === 'available') {
    desc = u.canInstall ? t('Version {version} is available.', { version: u.latest }) : t('Version {version} is available. This copy cannot replace itself, so download it from the release page.', { version: u.latest });
    action = (
      <div className="st-inline">
        <Button size="sm" variant="ghost" icon="external" onClick={openPage}>{t('What’s new')}</Button>
        {u.canInstall && <Button size="sm" variant="primary" icon="downloads" onClick={() => void attempt(() => api.invoke('launcher:downloadUpdate'))}>{t('Download and install')}</Button>}
      </div>
    );
  } else if (u.state === 'downloading') {
    desc = u.size ? t('Downloading version {version} · {done} of {total}', { version: u.latest, done: formatBytes(u.received), total: formatBytes(u.size) }) : t('Downloading version {version} · {done}', { version: u.latest, done: formatBytes(u.received) });
    action = <Button size="sm" variant="ghost" onClick={() => void attempt(() => api.invoke('launcher:cancelUpdate'))}>{t('Cancel')}</Button>;
  } else if (u.state === 'ready') {
    desc = t('Version {version} is downloaded and verified. Restarting takes a few seconds; downloads resume afterwards.', { version: u.latest });
    action = <Button size="sm" variant="primary" icon="reload" onClick={() => void attempt(() => api.invoke('launcher:installUpdate'))}>{t('Restart now')}</Button>;
  } else if (u.state === 'error') {
    desc = t('Could not check for updates: {detail}', { detail: u.error });
    action = <Button size="sm" variant="ghost" icon="reload" onClick={() => void attempt(() => api.invoke('launcher:checkUpdate'))}>{t('Try again')}</Button>;
  } else {
    desc = (u.state === 'up-to-date' ? t('You have the latest version ({version}).', { version: u.current }) : t('You have version {version}.', { version: u.current })) + checked;
    action = <Button size="sm" variant="ghost" icon="reload" onClick={() => void attempt(() => api.invoke('launcher:checkUpdate'))}>{t('Check now')}</Button>;
  }
  return (
    <Group title={t('Launcher updates')}>
      <Row label={t('Cool Games Launcher')} desc={desc}>{action}</Row>
      {u.state === 'downloading' && <div className="st-progress st-progress--inline"><span style={{ width: `${u.size ? Math.min(100, (u.received / u.size) * 100) : 0}%` }} /></div>}
      {u.notes && (u.state === 'available' || u.state === 'ready') && <p className="st-release-notes">{u.notes.length > 700 ? `${u.notes.slice(0, 700)}…` : u.notes}</p>}
      <Row label={t('Look for new versions automatically')} desc={t('Checks the project’s GitHub releases a few times a day. Nothing is downloaded until you choose to.')}>
        <Switch checked={settings.checkLauncherUpdates} label={t('Look for new versions automatically')} onChange={(v) => void update({ checkLauncherUpdates: v })} />
      </Row>
      <Row label={t('Install from a file')} desc={u.canInstall ? t('Replace this launcher with an AppImage you downloaded yourself. Your games, settings and downloads stay.') : t('Available when the launcher runs from its AppImage.')}>
        <Button size="sm" variant="ghost" icon="folder" disabled={!u.canInstall} onClick={() => void attempt(() => api.invoke('launcher:installFromFile'))}>{t('Choose AppImage…')}</Button>
      </Row>
    </Group>
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
    ['model', 'Fara1.5-9B by Microsoft', 'MIT', tk('downloaded on demand')],
  ];
  return (
    <>
      <StatusCard icon="sparkle" tone="ok" title={`Cool Games Launcher ${info?.appVersion ?? ''}`} detail={t('Free software under the GNU General Public License, version 3 or later.')}>
        <Button size="sm" variant="secondary" icon="folder" onClick={() => void attempt(() => api.invoke('app:openFolder', { which: 'logs' }))}>{t('Open log folder')}</Button>
      </StatusCard>
      <LauncherUpdates />
      <Group title={t('Problems?')}>
        <Row label={t('Create a diagnostics file')} desc={t('Writes one text file to your Downloads folder with the launcher\'s state, recent downloads and their errors, and the end of its logs (your home folder is shortened to ~). Send it with a description of what went wrong.')}>
          <Button size="sm" variant="secondary" icon="downloads" onClick={() => void attempt(async () => { const r = await api.invoke('app:diagnostics'); pushToast('success', t('Saved {file} in your Downloads folder.', { file: r.path.split('/').pop() })); })}>{t('Create file')}</Button>
        </Row>
      </Group>
      <Group title={t('Components')}>
        <ul className="st-components">
          {components.map(([key, name, license, note]) => (
            <li key={key}>
              <span className={`status-dot ${note || ready[key] ? 'is-ok' : 'is-missing'}`} aria-hidden="true" />
              <span>{name}</span>
              <span className="muted">{license}</span>
              <span className="muted">{note ? t(note) : ready[key] ? t('bundled') : t('missing')}</span>
            </li>
          ))}
        </ul>
      </Group>
      <Group title={t('Keyboard')}>
        <dl className="st-keys">
          <dt><kbd>{t('Ctrl')}</kbd> + <kbd>1</kbd>–<kbd>4</kbd></dt><dd>{t('Switch tabs')}</dd>
          <dt><kbd>/</kbd></dt><dd>{t('Search the Store')}</dd>
          <dt><kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd></dt><dd>{t('Move between games and tabs')}</dd>
          <dt><kbd>{t('Enter')}</kbd></dt><dd>{t('Open the focused game')}</dd>
          <dt><kbd>{t('Esc')}</kbd></dt><dd>{t('Close details, dialogs and browser focus')}</dd>
        </dl>
      </Group>
      <Group title={t('Where things are')}>
        <dl className="st-paths">
          <dt>{t('Data')}</dt><dd className="mono">{info?.dataDir}</dd>
          <dt>{t('Cache')}</dt><dd className="mono">{info?.cacheDir}</dd>
          <dt>{t('Config')}</dt><dd className="mono">{info?.configDir}</dd>
        </dl>
      </Group>
      <p className="st-note">{t('Only download games you are allowed to download. The launcher never bypasses DRM, purchases, sign-ins or CAPTCHAs. This program comes with absolutely no warranty, to the extent permitted by law.')}</p>
    </>
  );
}
