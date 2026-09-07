/** Ground elevation in feet from the free Open-Meteo elevation API (worldwide, no key). */
export async function elevationFt(lat: number, lng: number): Promise<number | null> {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    const m = Array.isArray(j.elevation) ? j.elevation[0] : null;
    return typeof m === "number" ? Math.round(m * 3.28084) : null;
  } catch { return null; }
}
export const MAX_ELEVATION_FT = 5000;
export const elevationNote = (ft: number | null) => ft == null ? "" : ft > MAX_ELEVATION_FT ? `ELEVATION WARNING: ${ft} ft, above the family's 5,000 ft health limit. This is a serious negative: call it out first in the cons/red flags and score it down.` : ft > 4000 ? `Elevation ${ft} ft: borderline for the family's 5,000 ft health limit; mention it.` : `Elevation ${ft} ft (fine).`;
