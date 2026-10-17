/** Website posting dates, separate from a game's Steam release date. Relative
 * labels are resolved against the page observation, never a later database read. */
export function parseSiteDate(raw: string | null | undefined, observedAt: string | number = Date.now()): { iso: string; relative: boolean } | null {
  if (!raw) return null;
  const observed = typeof observedAt === 'number' ? observedAt : Date.parse(observedAt);
  if (!Number.isFinite(observed)) return null;
  const text = raw.trim().replace(/^(?:posted|published|added)(?:\s+on)?\s*[:：-]?\s*/i, '').replace(/\s+/g, ' ');
  if (!text || text.length > 150 || /\b(?:updated|modified|release|copyright|playtime)\b/i.test(text)) return null;
  const finish = (at: number, relative: boolean) => Number.isFinite(at) && at >= Date.UTC(1990,0,1) && at <= observed + 5 * 60_000 ? {iso:new Date(at).toISOString(),relative} : null;
  if (/^(?:just now|moments? ago|today)$/i.test(text)) return finish(observed, true);
  if (/^yesterday$/i.test(text)) return finish(observed - 86400_000, true);
  const compact = /^(\d+(?:\.\d+)?)\s*([smhdw])(?:\s+ago)?$/i.exec(text);
  if(compact){const units:Record<string,number>={s:1000,m:60_000,h:3600_000,d:86400_000,w:604800_000};return finish(observed-Number(compact[1])*units[compact[2].toLowerCase()],true);}
  const relative = /^(?:(\d+(?:\.\d+)?)|(an?|one))\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)(?:\s+ago)?$/i.exec(text);
  if (relative) {
    const units: Record<string,number> = {s:1000,m:60_000,h:3600_000,d:86400_000,w:7*86400_000,y:365.25*86400_000};
    const unit=relative[3].toLowerCase(), duration=unit.startsWith('month') ? 30.4375*86400_000 : units[unit[0]];
    return finish(observed - Number(relative[1] ?? 1) * duration, true);
  }
  if (/^\d{10}(?:\d{3})?$/.test(text)) return finish(Number(text) * (text.length===10?1000:1), false);
  if (/^\d{4}-\d{2}-\d{2}(?:[ T].*)?$/.test(text)) {
    const y=Number(text.slice(0,4)),m=Number(text.slice(5,7)),d=Number(text.slice(8,10));
    const date=new Date(Date.UTC(y,m-1,d));
    if(date.getUTCFullYear()!==y||date.getUTCMonth()!==m-1||date.getUTCDate()!==d)return null;
    return finish(Date.parse(text.length===10?text+'T00:00:00Z':text),false);
  }
  // Numeric dates without a declared locale are ambiguous; don't guess MM/DD.
  const numeric=/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(text);
  if(numeric){const d=Number(numeric[1]),m=Number(numeric[2]),y=Number(numeric[3]);if(d<=12)return null;const at=Date.UTC(y,m-1,d),date=new Date(at);return date.getUTCMonth()===m-1&&date.getUTCDate()===d?finish(at,false):null;}
  if (/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/i.test(text) && /\b\d{4}\b/.test(text)) return finish(Date.parse(text.replace(/(\d)(?:st|nd|rd|th)\b/g,'$1') + (/\b(?:GMT|UTC)\b|[+-]\d{2}:?\d{2}$/.test(text)?'':' UTC')),false);
  return null;
}
