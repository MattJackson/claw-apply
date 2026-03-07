/**
 * profile.mjs — Per-track profile management
 *
 * Each search track can override parts of the base profile.json:
 *   - profile_overrides: { ... } inline in search_config.json
 *   - profile_path: "config/profiles/se_profile.json" (loaded + merged)
 *
 * Base profile has shared info (name, phone, location, work auth).
 * Track overrides customize resume, cover letter, experience highlights, etc.
 */
import { loadJSON } from './storage.mjs';

/**
 * Deep merge b into a (b wins on conflicts). Arrays are replaced, not concatenated.
 */
function deepMerge(a, b) {
  const result = { ...a };
  for (const [key, val] of Object.entries(b)) {
    if (val && typeof val === 'object' && !Array.isArray(val) && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Build per-track profile map from base profile + search config.
 * Returns { _base: baseProfile, trackKey: mergedProfile, ... }
 */
export async function buildTrackProfiles(baseProfile, searches) {
  const profiles = { _base: baseProfile };

  for (const search of searches) {
    const track = search.track;
    let trackProfile = baseProfile;

    // Load external profile file if specified
    if (search.profile_path) {
      try {
        const overrides = await loadJSON(search.profile_path, null);
        if (overrides) trackProfile = deepMerge(trackProfile, overrides);
      } catch (e) {
        console.warn(`  ⚠️  [${track}] Could not load profile ${search.profile_path}: ${e.message}`);
      }
    }

    // Apply inline overrides (takes precedence over profile_path)
    if (search.profile_overrides) {
      trackProfile = deepMerge(trackProfile, search.profile_overrides);
    }

    profiles[track] = trackProfile;
  }

  return profiles;
}

/**
 * Get the profile for a specific track from a profiles map.
 */
export function getTrackProfile(profilesByTrack, track) {
  return profilesByTrack[track] || profilesByTrack._base;
}
